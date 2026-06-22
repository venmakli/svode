import { useState } from "react";
import { toast } from "sonner";
import * as m from "@/paraglide/messages.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useIdentityStore } from "../model";
import { isValidEmail, isValidName } from "../lib";

export function IdentityDialog({ open }: { open: boolean }) {
  const { saveGlobal } = useIdentityStore();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState<{ name: boolean; email: boolean }>({
    name: false,
    email: false,
  });

  const nameValid = isValidName(name);
  const emailValid = isValidEmail(email);
  const canSubmit = nameValid && emailValid && !saving;

  async function handleSave() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await saveGlobal(name.trim(), email.trim());
    } catch (err) {
      console.error("save global identity failed:", err);
      toast.error(m.toast_error());
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="sm:max-w-md"
      >
        <DialogTitle>{m.identity_dialog_title()}</DialogTitle>
        <DialogDescription>{m.identity_dialog_description()}</DialogDescription>

        <div className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="identity-name">{m.identity_name_label()}</Label>
            <Input
              id="identity-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              autoFocus
            />
            {touched.name && !nameValid && (
              <p className="text-xs text-destructive">{m.identity_name_empty()}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="identity-email">{m.identity_email_label()}</Label>
            <Input
              id="identity-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
            />
            {touched.email && !emailValid && (
              <p className="text-xs text-destructive">
                {m.identity_email_invalid()}
              </p>
            )}
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={handleSave} disabled={!canSubmit}>
              {m.identity_save()}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
