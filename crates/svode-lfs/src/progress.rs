//! `progress` events of one transfer for Git LFS: at least every [`STEP`]
//! bytes or every [`PERIOD`] while bytes move, and the last one at the object
//! size before `complete`.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::write_line;

const STEP: u64 = 1024 * 1024;
const PERIOD: Duration = Duration::from_secs(1);

/// Bytes of the current transfer, counted where the network takes or gives
/// them. The agent handles one request at a time, so one counter serves all
/// transfers of a session.
#[derive(Clone)]
pub(crate) struct Counter(Arc<watch::Sender<u64>>);

impl Counter {
    pub(crate) fn new() -> Self {
        Self(Arc::new(watch::Sender::new(0)))
    }

    pub(crate) fn add(&self, bytes: u64) {
        self.0.send_modify(|total| *total += bytes);
    }

    pub(crate) fn start(&self) -> watch::Receiver<u64> {
        self.0.send_replace(0);
        self.0.subscribe()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent<'a> {
    event: &'static str,
    oid: &'a str,
    bytes_so_far: u64,
    bytes_since_last: u64,
}

/// Runs `transfer` and reports its bytes from `counter` to `out` meanwhile.
/// The outer error is a failed write to Git LFS, the inner one the transfer.
pub(crate) async fn report<W, T>(
    out: &mut W,
    counter: &Counter,
    oid: &str,
    size: u64,
    transfer: impl Future<Output = Result<T>>,
) -> Result<Result<T>>
where
    W: AsyncWriteExt + Unpin,
{
    let mut seen = counter.start();
    let mut transfer = std::pin::pin!(transfer);
    let mut reported = 0;
    let mut last = Instant::now();
    loop {
        let current = (*seen.borrow_and_update()).min(size);
        if current > reported && (current - reported >= STEP || last.elapsed() >= PERIOD) {
            emit(out, oid, current, reported).await?;
            reported = current;
            last = Instant::now();
        }
        let pending = current > reported;
        tokio::select! {
            biased;
            result = transfer.as_mut() => {
                if result.is_ok() && size > reported {
                    emit(out, oid, size, reported).await?;
                }
                return Ok(result);
            }
            _ = seen.changed() => {}
            _ = tokio::time::sleep_until(last + PERIOD), if pending => {}
        }
    }
}

async fn emit<W>(out: &mut W, oid: &str, bytes_so_far: u64, reported: u64) -> Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    write_line(
        out,
        &ProgressEvent {
            event: "progress",
            oid,
            bytes_so_far,
            bytes_since_last: bytes_so_far - reported,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(out: &[u8]) -> Vec<(u64, u64)> {
        String::from_utf8_lossy(out)
            .lines()
            .map(|line| {
                let event: serde_json::Value = serde_json::from_str(line).unwrap();
                assert_eq!(event["event"], "progress");
                assert_eq!(event["oid"], "oid");
                (
                    event["bytesSoFar"].as_u64().unwrap(),
                    event["bytesSinceLast"].as_u64().unwrap(),
                )
            })
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn reports_every_step_and_every_period_and_ends_at_the_size() {
        let counter = Counter::new();
        let mut out = Vec::new();
        let size = 3 * STEP + 10;
        let source = counter.clone();
        let result = report(&mut out, &counter, "oid", size, async move {
            // Two steps quickly, in pieces smaller than a step.
            for _ in 0..8 {
                source.add(STEP / 4);
                tokio::task::yield_now().await;
            }
            // A slow trickle: one event per period, not per piece.
            for _ in 0..4 {
                source.add(100);
                tokio::time::sleep(PERIOD * 2 / 5).await;
            }
            // A stall with nothing new: no event.
            tokio::time::sleep(PERIOD * 5).await;
            Ok("done")
        })
        .await
        .unwrap();
        assert_eq!(result.unwrap(), "done");
        assert_eq!(
            events(&out),
            [
                (STEP, STEP),
                (2 * STEP, STEP),
                (2 * STEP + 300, 300),
                (2 * STEP + 400, 100),
                (size, size - 2 * STEP - 400),
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_failed_transfer_does_not_claim_the_size_and_counting_restarts() {
        let counter = Counter::new();
        let mut out = Vec::new();
        let source = counter.clone();
        let result = report(&mut out, &counter, "oid", 10 * STEP, async move {
            source.add(STEP);
            tokio::task::yield_now().await;
            source.add(STEP);
            Err::<(), _>(anyhow::anyhow!("network"))
        })
        .await
        .unwrap();
        assert!(result.is_err());
        assert_eq!(events(&out), [(STEP, STEP)]);

        // The next transfer of the session counts from zero, capped at its size.
        let mut out = Vec::new();
        let source = counter.clone();
        report(&mut out, &counter, "oid", 5, async move {
            source.add(9);
            Ok(())
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(events(&out), [(5, 5)]);
    }
}
