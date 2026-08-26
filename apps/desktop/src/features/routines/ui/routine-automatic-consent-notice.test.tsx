import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { Dialog } from "@/components/ui/dialog";

import {
  RoutineAutomaticConsentNotice,
  RoutineAutomaticConsentNoticeContent,
} from "./routine-automatic-consent-notice";

test("storage reset uses a compact dialog trigger next to the authority control", () => {
  const trigger = renderToStaticMarkup(
    <RoutineAutomaticConsentNotice
      automaticError={null}
      loading={false}
      recoveryError={null}
      recoveryPending={false}
      storageResetPending
      onDismissReset={() => undefined}
      onRetry={() => undefined}
    />,
  );
  const content = renderToStaticMarkup(
    <Dialog>
      <RoutineAutomaticConsentNoticeContent
        automaticError={null}
        loading={false}
        recoveryError={null}
        recoveryPending={false}
        storageResetPending
        onDismissReset={() => undefined}
        onRetry={() => undefined}
      />
    </Dialog>,
  );

  expect(trigger.includes('aria-haspopup="dialog"')).toBe(true);
  expect(trigger.includes("Local routine data was recreated")).toBe(true);
  expect(content.includes("couldn&#x27;t find or open")).toBe(true);
  expect(content.includes("Your routines are still available")).toBe(true);
  expect(content.includes("automatic runs were turned off")).toBe(true);
  expect(content.includes("Got it")).toBe(true);
  expect(content.includes("quarantine")).toBe(false);
  expect(content.includes("database")).toBe(false);
});

test("authority failures keep retry in the contextual dialog", () => {
  const content = renderToStaticMarkup(
    <Dialog>
      <RoutineAutomaticConsentNoticeContent
        automaticError="read failed"
        loading={false}
        recoveryError={null}
        recoveryPending={false}
        storageResetPending={false}
        onDismissReset={() => undefined}
        onRetry={() => undefined}
      />
    </Dialog>,
  );

  expect(content.includes("Automatic runs are unavailable")).toBe(true);
  expect(content.includes("read failed")).toBe(true);
  expect(content.includes("Retry")).toBe(true);
});
