import { memo, useMemo } from "react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";

const StreamdownTextImpl = () => {
  const plugins = useMemo(() => ({ code }), []);

  return (
    <StreamdownTextPrimitive
      plugins={plugins}
      shikiTheme={["github-light", "github-dark"]}
    />
  );
};

export const MarkdownText = memo(StreamdownTextImpl);
