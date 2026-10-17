import { expect, test } from "bun:test";
import { setLocale } from "@/paraglide/runtime";
import {
  contentDeleteCopy,
  pageFormOfPath,
  type DeletableContentObject,
} from "./delete-confirmation";

const nested = { subpageCount: 2, otherFileCount: 0 };
const filesOnly = { subpageCount: 0, otherFileCount: 1 };
const empty = { subpageCount: 0, otherFileCount: 0 };

function copy(object: DeletableContentObject) {
  return contentDeleteCopy(object, "Roadmap");
}

test("the title names the type and the text the object and what goes", () => {
  expect(copy({ kind: "page", form: "leaf" })).toEqual({
    title: "Delete page?",
    description: "The page “Roadmap” will be deleted.",
  });
  expect(copy({ kind: "collection-item", form: "leaf" })).toEqual({
    title: "Delete collection item?",
    description: "The collection item “Roadmap” will be deleted.",
  });
  expect(copy({ kind: "template", form: "leaf", isDefault: true }).title).toBe(
    "Delete template?",
  );
  expect(copy({ kind: "folder" })).toEqual({
    title: "Delete folder?",
    description:
      "The folder “Roadmap” and everything inside it will be deleted.",
  });
  expect(copy({ kind: "collection" })).toEqual({
    title: "Delete collection?",
    description:
      "The collection “Roadmap” will be deleted with its schema and all items.",
  });
  expect(copy({ kind: "app" })).toEqual({
    title: "Delete app?",
    description: "The app “Roadmap” will be deleted with its files.",
  });
});

test("a folder Page names its nested pages and files only when it has them", () => {
  expect(
    copy({ kind: "page", form: "folder", contents: nested }).description,
  ).toBe("The page “Roadmap” will be deleted with its nested pages and files.");
  expect(
    copy({ kind: "page", form: "folder", contents: filesOnly }).description,
  ).toBe("The page “Roadmap” will be deleted with its nested pages and files.");
  expect(
    copy({ kind: "page", form: "folder", contents: empty }).description,
  ).toBe("The page “Roadmap” will be deleted.");
  expect(copy({ kind: "page", form: "folder" }).description).toBe(
    "The page “Roadmap” will be deleted.",
  );
  expect(
    copy({ kind: "collection-item", form: "folder", contents: nested })
      .description,
  ).toBe(
    "The collection item “Roadmap” will be deleted with its nested pages and files.",
  );
  expect(
    copy({
      kind: "template",
      form: "folder",
      contents: nested,
      isDefault: false,
    }).description,
  ).toBe(
    "The template “Roadmap” will be deleted with its nested pages and files.",
  );
});

test("Russian copy names the type in product words", () => {
  setLocale("ru", { reload: false });
  try {
    expect(copy({ kind: "page", form: "leaf" })).toEqual({
      title: "Удалить страницу?",
      description: "Страница «Roadmap» будет удалена.",
    });
    expect(copy({ kind: "folder" })).toEqual({
      title: "Удалить папку?",
      description: "Папка «Roadmap» и всё её содержимое будут удалены.",
    });
    expect(copy({ kind: "collection-item", form: "leaf" }).title).toBe(
      "Удалить элемент коллекции?",
    );
    expect(
      copy({ kind: "template", form: "leaf", isDefault: false }).title,
    ).toBe("Удалить шаблон?");
    expect(copy({ kind: "collection" }).title).toBe("Удалить коллекцию?");
    expect(copy({ kind: "app" }).title).toBe("Удалить приложение?");
    expect(
      copy({ kind: "page", form: "folder", contents: nested }).description,
    ).toBe(
      "Страница «Roadmap» будет удалена вместе с вложенными страницами и файлами.",
    );
  } finally {
    setLocale("en", { reload: false });
  }
});

test("a folder Page is the README of its folder", () => {
  expect(pageFormOfPath("guide/README.md")).toBe("folder");
  expect(pageFormOfPath("a/b/readme.md")).toBe("folder");
  expect(pageFormOfPath("doc.md")).toBe("leaf");
  // The README of a Space root is one file of the Space.
  expect(pageFormOfPath("README.md")).toBe("leaf");
});
