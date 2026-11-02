import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Copy, ExternalLink, Link, Mail, PhoneCall, Text } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fallbackUrlTitle, normalizeUrlValue } from "../../lib/url";
import {
  copyPropertyValue,
  openPropertyExternal,
} from "../../api/property-actions";
import { isValidEmail, isValidPhone, isValidUrl } from "../../lib/utils";
import * as m from "@/paraglide/messages.js";
import {
  deferStateUpdate,
  IconAction,
  useAutoOpen,
  usePropertyTextDraft,
} from "./common";
import type { PropertyControlProps } from "./types";

/**
 * A link: its address in the field and, in a popover, the address and the
 * text. Leaving a changed field saves the link; Escape in any of its fields
 * puts the saved link back without saving.
 */
export function UrlControl({
  value,
  invalid,
  disabled,
  autoOpen,
  onChange,
  onOpenChange,
}: Pick<
  PropertyControlProps,
  "value" | "invalid" | "disabled" | "autoOpen" | "onChange" | "onOpenChange"
>) {
  const [open, setOpen] = useAutoOpen(autoOpen, onOpenChange);
  const normalized = normalizeUrlValue(value);
  const [draft, setDraft] = useState(normalized.href);
  const [text, setText] = useState(normalized.title);
  // Set by Escape until the next edit, so the blur it causes does not save.
  const cancelledRef = useRef(false);
  useEffect(() => {
    return deferStateUpdate(() => {
      const next = normalizeUrlValue(value);
      setDraft(next.href);
      setText(next.title);
    });
  }, [value]);
  const warning = invalid || (draft ? !isValidUrl(draft) : false);
  const commit = () => {
    if (cancelledRef.current) return;
    const href = draft.trim();
    const title = text.trim();
    if (href === normalized.href && title === normalized.title) return;
    void onChange(
      href ? { href, title: title || fallbackUrlTitle(href) } : null,
    );
  };
  const fieldProps = {
    onBlur: commit,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;
      cancelledRef.current = true;
      setDraft(normalized.href);
      setText(normalized.title);
    },
  };
  const edit = (update: () => void) => {
    cancelledRef.current = false;
    update();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="group/control relative">
          <Input
            {...fieldProps}
            value={draft}
            disabled={disabled}
            aria-invalid={warning || undefined}
            onChange={(event) => edit(() => setDraft(event.target.value))}
            className="pr-16"
          />
          <div className="absolute top-1/2 right-1 flex -translate-y-1/2 opacity-0 group-focus-within/control:opacity-100 group-hover/control:opacity-100">
            <IconAction
              label={m.property_action_open()}
              onClick={() => openPropertyExternal(draft)}
              disabled={!isValidUrl(draft)}
            >
              <ExternalLink />
            </IconAction>
            <IconAction
              label={m.property_action_copy()}
              onClick={() => copyPropertyValue(draft)}
              disabled={!draft}
            >
              <Copy />
            </IconAction>
          </div>
        </div>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-80">
        <div className="grid grid-cols-[auto_1fr] items-center gap-2">
          <Link className="text-muted-foreground" />
          <Input
            {...fieldProps}
            value={draft}
            placeholder={m.page_link_url_placeholder()}
            autoFocus={autoOpen}
            onChange={(event) => edit(() => setDraft(event.target.value))}
          />
          <Text className="text-muted-foreground" />
          <Input
            {...fieldProps}
            value={text}
            placeholder={m.page_link_text_placeholder()}
            onChange={(event) => edit(() => setText(event.target.value))}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function EmailControl({
  value,
  invalid,
  disabled,
  autoOpen,
  placeholder,
  onChange,
}: Pick<
  PropertyControlProps,
  "value" | "invalid" | "disabled" | "autoOpen" | "placeholder" | "onChange"
>) {
  const { draft, inputProps } = usePropertyTextDraft(
    value,
    (next) => void onChange(next || null),
  );
  const warning = invalid || !isValidEmail(draft);
  return (
    <div className="group/control relative">
      <Input
        {...inputProps}
        autoFocus={autoOpen}
        type="email"
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={warning || undefined}
        className="pr-16"
      />
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 opacity-0 group-focus-within/control:opacity-100 group-hover/control:opacity-100">
        <IconAction
          label={m.property_action_email()}
          onClick={() => openPropertyExternal(`mailto:${draft}`)}
          disabled={!isValidEmail(draft)}
        >
          <Mail />
        </IconAction>
        <IconAction
          label={m.property_action_copy()}
          onClick={() => copyPropertyValue(draft)}
          disabled={!draft}
        >
          <Copy />
        </IconAction>
      </div>
    </div>
  );
}

export function PhoneControl({
  value,
  invalid,
  disabled,
  autoOpen,
  placeholder,
  onChange,
}: Pick<
  PropertyControlProps,
  "value" | "invalid" | "disabled" | "autoOpen" | "placeholder" | "onChange"
>) {
  const { draft, inputProps } = usePropertyTextDraft(
    value,
    (next) => void onChange(next || null),
  );
  const warning = invalid || !isValidPhone(draft);
  return (
    <div className="group/control relative">
      <Input
        {...inputProps}
        autoFocus={autoOpen}
        type="tel"
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={warning || undefined}
        className="pr-16"
      />
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 opacity-0 group-focus-within/control:opacity-100 group-hover/control:opacity-100">
        <IconAction
          label={m.property_action_call()}
          onClick={() => openPropertyExternal(`tel:${draft}`)}
          disabled={!isValidPhone(draft)}
        >
          <PhoneCall />
        </IconAction>
        <IconAction
          label={m.property_action_copy()}
          onClick={() => copyPropertyValue(draft)}
          disabled={!draft}
        >
          <Copy />
        </IconAction>
      </div>
    </div>
  );
}
