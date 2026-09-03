import { expect, test } from "bun:test";

import { DocumentRuntimeSession, documentSessionCoordinator } from "./session";

test("activating a new document destroys the previous live session", async () => {
  documentSessionCoordinator.resetForTests();
  const destroyed: number[] = [];
  const first = new DocumentRuntimeSession(1, "space\0first.pdf");
  first.addDisposer(() => {
    destroyed.push(first.id);
  });
  const second = new DocumentRuntimeSession(2, "space\0second.pdf");
  second.addDisposer(() => {
    destroyed.push(second.id);
  });

  expect(await documentSessionCoordinator.activate(first)).toBe(true);
  expect(await documentSessionCoordinator.activate(second)).toBe(true);
  expect(destroyed).toEqual([1]);
  await documentSessionCoordinator.release(second);
  expect(destroyed).toEqual([1, 2]);
});

test("peek handoff destroys its renderer and transfers view state once", async () => {
  documentSessionCoordinator.resetForTests();
  const first = new DocumentRuntimeSession(1, "space\0guide.pdf");
  first.setViewState({
    ...first.getViewState(),
    pageNumber: 7,
    rotation: 90,
    zoomMode: "page",
  });
  expect(await documentSessionCoordinator.activate(first)).toBe(true);
  await documentSessionCoordinator.handoff(first);
  expect(first.signal.aborted).toBe(true);

  const fullPage = new DocumentRuntimeSession(2, "space\0guide.pdf");
  expect(await documentSessionCoordinator.activate(fullPage)).toBe(true);
  expect(fullPage.getViewState().pageNumber).toBe(7);
  expect(fullPage.getViewState().rotation).toBe(90);
  expect(fullPage.getViewState().zoomMode).toBe("page");

  const reopened = new DocumentRuntimeSession(3, "space\0guide.pdf");
  expect(await documentSessionCoordinator.activate(reopened)).toBe(true);
  expect(reopened.getViewState().pageNumber).toBe(1);
  await documentSessionCoordinator.release(reopened);
});

test("repeated open and close leaves every runtime session destroyed", async () => {
  documentSessionCoordinator.resetForTests();
  const sessions = Array.from(
    { length: 8 },
    (_, index) => new DocumentRuntimeSession(index, `space\0${index}.pdf`),
  );
  for (const session of sessions) {
    expect(await documentSessionCoordinator.activate(session)).toBe(true);
    await documentSessionCoordinator.release(session);
  }
  expect(sessions.every((session) => session.signal.aborted)).toBe(true);
});
