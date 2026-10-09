import { useExternalOpenGroup } from "../hooks/use-external-open-group";
import type { ExternalOpenBinding } from "../model/types";
import {
  OpenWithControl,
  type OpenWithControlProps,
} from "./open-with-control";

type ExternalOpenButtonProps = ExternalOpenBinding &
  Omit<OpenWithControlProps, "groups">;

/** Split control: open in the primary application, or choose another one. */
export function ExternalOpenButton({
  target,
  onError,
  ...control
}: ExternalOpenButtonProps) {
  const group = useExternalOpenGroup({ target, onError });
  return <OpenWithControl groups={[group]} {...control} />;
}
