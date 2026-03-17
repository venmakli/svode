import { Node } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { type?: string }) => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",

  addAttributes() {
    return {
      type: {
        default: "info",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-type"),
        renderHTML: (attributes: Record<string, string>) => ({
          "data-type": attributes.type,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "div[data-callout]",
        getAttrs: (node: HTMLElement) => ({
          type: node.getAttribute("data-type"),
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }: { node: any; HTMLAttributes: Record<string, any> }) {
    const type = node.attrs.type || "info";
    const icons: Record<string, string> = {
      info: "ℹ️",
      warning: "⚠️",
      error: "❌",
      tip: "💡",
    };

    return [
      "div",
      {
        "data-callout": "",
        "data-type": type,
        class: `callout callout-${type}`,
        ...HTMLAttributes,
      },
      ["span", { class: "callout-icon", contenteditable: "false" }, icons[type] || "ℹ️"],
      ["div", { class: "callout-content" }, 0],
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attrs: { type?: string } | undefined) =>
        ({ commands }: { commands: any }) => {
          return commands.wrapIn(this.name, attrs);
        },
    };
  },

  markdownTokenizer: {
    name: "callout",
    level: "block" as const,

    start: (src: string) => src.indexOf(":::"),

    tokenize: (src: string, _tokens: any[], lexer: any) => {
      const match = /^:::(\w+)\n([\s\S]*?)\n:::(\n?)/.exec(src);
      if (!match) return undefined;

      return {
        type: "callout",
        raw: match[0],
        calloutType: match[1],
        text: match[2],
        tokens: lexer.blockTokens(match[2]),
      };
    },
  },

  parseMarkdown: (token: any, helpers: any) => {
    return {
      type: "callout",
      attrs: {
        type: token.calloutType || "info",
      },
      content: helpers.parseChildren(token.tokens || []),
    };
  },

  renderMarkdown: (node: any, helpers: any) => {
    const type = node.attrs?.type || "info";
    const content = helpers.renderChildren(node.content || []);
    return `:::${type}\n${content}\n:::\n\n`;
  },
});
