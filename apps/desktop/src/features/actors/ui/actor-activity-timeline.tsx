import { getLocale } from "@/paraglide/runtime.js";

import * as m from "@/paraglide/messages.js";

import type { ActorActivitySnapshot } from "../model/types";

export function ActorActivityTimeline({
  activity,
}: {
  activity: ActorActivitySnapshot;
}) {
  return (
    <div className="flex flex-col gap-5" data-actor-activity-timeline>
      {activity.timeline.months.map((month) => (
        <section className="flex flex-col gap-2" key={month.month}>
          <header className="flex items-baseline justify-between gap-3">
            <h4 className="text-sm font-semibold capitalize">
              {formatActivityMonth(month.month)}
            </h4>
            <span className="text-xs text-muted-foreground">
              {m.actors_activity_month_commits({
                count: String(month.commitCount),
              })}
            </span>
          </header>
          <ol className="divide-y rounded-lg border bg-card">
            {month.commits.map((commit) => (
              <li
                className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-2 px-3 py-2 text-sm"
                key={`${commit.authoredAt}:${commit.shortSha}:${commit.subject}`}
              >
                <span className="min-w-0 break-words">{commit.subject}</span>
                <time
                  className="text-xs tabular-nums text-muted-foreground"
                  dateTime={`${commit.localDate}T${commit.localTime}`}
                >
                  {commit.localTime}
                </time>
                <code className="text-xs text-muted-foreground">
                  {commit.shortSha}
                </code>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function formatActivityMonth(month: string) {
  const match = /^(\d{4})-(\d{2})$/u.exec(month);
  if (!match) return month;
  return new Intl.DateTimeFormat(getLocale(), {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}
