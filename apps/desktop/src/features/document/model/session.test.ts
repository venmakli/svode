import { expect, test } from "bun:test";

import { createDocumentViewState } from "./types";
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

test("XLSX opens at 100% while an explicit fit mode survives handoff", async () => {
  documentSessionCoordinator.resetForTests();
  const peek = new DocumentRuntimeSession(
    1,
    "space\0table.xlsx",
    createDocumentViewState("xlsx"),
  );
  expect(peek.getViewState().zoom).toBe(1);
  expect(peek.getViewState().zoomMode).toBe("custom");

  expect(await documentSessionCoordinator.activate(peek)).toBe(true);
  peek.setViewState({ ...peek.getViewState(), zoom: 0.37, zoomMode: "width" });
  await documentSessionCoordinator.handoff(peek);

  const fullPage = new DocumentRuntimeSession(
    2,
    "space\0table.xlsx",
    createDocumentViewState("xlsx"),
  );
  expect(await documentSessionCoordinator.activate(fullPage)).toBe(true);
  expect(fullPage.getViewState().zoom).toBe(0.37);
  expect(fullPage.getViewState().zoomMode).toBe("width");
  await documentSessionCoordinator.release(fullPage);
});

test("PPTX opens fit to page and transfers the active slide on handoff", async () => {
  documentSessionCoordinator.resetForTests();
  const peek = new DocumentRuntimeSession(
    1,
    "space\0deck.pptx",
    createDocumentViewState("pptx"),
  );
  expect(peek.getViewState().zoomMode).toBe("page");
  expect(await documentSessionCoordinator.activate(peek)).toBe(true);
  peek.setViewState({ ...peek.getViewState(), slideNumber: 7 });
  await documentSessionCoordinator.handoff(peek);

  const fullPage = new DocumentRuntimeSession(
    2,
    "space\0deck.pptx",
    createDocumentViewState("pptx"),
  );
  expect(await documentSessionCoordinator.activate(fullPage)).toBe(true);
  expect(fullPage.getViewState().slideNumber).toBe(7);
  await documentSessionCoordinator.release(fullPage);
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

test("session destroys a renderer before its borrowed document", async () => {
  const session = new DocumentRuntimeSession(1, "space\0brief.docx");
  const order: string[] = [];
  session.addDisposer(() => {
    order.push("document");
  });
  session.addDisposer(() => {
    order.push("viewer");
  });

  await session.destroy();

  expect(order).toEqual(["viewer", "document"]);
});

test("a renderer can unregister after local unmount", async () => {
  const session = new DocumentRuntimeSession(1, "space\0brief.docx");
  let destroyed = 0;
  const unregister = session.addDisposer(() => {
    destroyed += 1;
  });

  unregister();
  await session.destroy();

  expect(destroyed).toBe(0);
});
