import { useEffect, useState } from "react";
import { Copy, ExternalLink, Link, Mail, PhoneCall, Text } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  fallbackUrlTitle,
  normalizeUrlValue,
} from "../../lib/url";
import {
  copyPropertyValue,
  openPropertyExternal,
} from "../../api/property-actions";
import {
  isValidEmail,
  isValidPhone,
  isValidUrl,
  valueToString,
} from "../../lib/utils";
import * as m from "@/paraglide/messages.js";
import { deferStateUpdate, IconAction, useAutoOpen } from "./common";
import type { PropertyControlProps } from "./types";

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
  useEffect(() => {
    return deferStateUpdate(() => {
      const next = normalizeUrlValue(value);
      setDraft(next.href);
      setText(next.title);
    });
  }, [value]);
  const warning = invalid || (draft ? !isValidUrl(draft) : false);
  const commit = () => {
    const href = draft.trim();
    const title = text.trim();
    void onChange(
      href ? { href, title: title || fallbackUrlTitle(href) } : null,
    );
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="group/control relative">
          <Input
            value={draft}
            disabled={disabled}
            aria-invalid={warning || undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
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
            value={draft}
            placeholder={m.doc_link_url_placeholder()}
            autoFocus={autoOpen}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
          />
          <Text className="text-muted-foreground" />
          <Input
            value={text}
            placeholder={m.doc_link_text_placeholder()}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
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
  onChange,
}: Pick<
  PropertyControlProps,
  "value" | "invalid" | "disabled" | "autoOpen" | "onChange"
>) {
  const [draft, setDraft] = useState(valueToString(value));
  useEffect(
    () => deferStateUpdate(() => setDraft(valueToString(value))),
    [value],
  );
  const warning = invalid || !isValidEmail(draft);
  return (
    <div className="group/control relative">
      <Input
        autoFocus={autoOpen}
        type="email"
        value={draft}
        disabled={disabled}
        aria-invalid={warning || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void onChange(draft || null)}
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
  onChange,
}: Pick<
  PropertyControlProps,
  "value" | "invalid" | "disabled" | "autoOpen" | "onChange"
>) {
  const [draft, setDraft] = useState(valueToString(value));
  useEffect(
    () => deferStateUpdate(() => setDraft(valueToString(value))),
    [value],
  );
  const warning = invalid || !isValidPhone(draft);
  return (
    <div className="group/control relative">
      <Input
        autoFocus={autoOpen}
        type="tel"
        value={draft}
        disabled={disabled}
        aria-invalid={warning || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void onChange(draft || null)}
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
