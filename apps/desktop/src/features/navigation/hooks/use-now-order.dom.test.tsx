import { expect, test } from "bun:test";
import { createTestDom } from "@/shared/testing/dom";
import { hideNowRow, type NowOrderRow } from "../model/now-order";
import { useNowOrder } from "./use-now-order";

test("rows read in part keep the hidden rows and the order of a project (DF-207 R4, DF-206 R6)", async () => {
  const dom = await createTestDom();
  const project = "/projects/partial-read";
  const shown: string[][] = [];
  function Now({ rows, complete }: { rows: NowOrderRow[]; complete: boolean }) {
    const order = useNowOrder(project, rows, complete);
    shown.push(order.map((index) => rows[index].ids[0]));
    return null;
  }
  const session = (id: string): NowOrderRow => ({
    ids: [id],
    signs: [true, false, false, false],
  });
  try {
    await dom.render(
      <Now rows={[session("late"), session("hidden")]} complete />,
    );
    await dom.render(
      <Now
        rows={[session("late"), session("hidden"), session("early")]}
        complete
      />,
    );
    hideNowRow(project, session("hidden"));
    // Before the sessions are read only the kept rows are known.
    await dom.render(<Now rows={[]} complete={false} />);
    await dom.render(
      <Now
        rows={[session("early"), session("hidden"), session("late")]}
        complete
      />,
    );
    expect(shown.at(-1)).toEqual(["late", "early"]);
  } finally {
    await dom.dispose();
  }
});
