import { useExternalOpenGroup } from "../hooks/use-external-open-group";
import { useExternalOpenGroupHost } from "./external-open-group-host";
import type { ExternalOpenBinding } from "../model/types";
import {
  OpenWithControl,
  type OpenWithControlProps,
} from "./open-with-control";

type ExternalOpenButtonProps = ExternalOpenBinding &
  Omit<OpenWithControlProps, "groups">;

/**
 * Split control: open in the primary application, or choose another one.
 * Inside an `ExternalOpenGroupHost` the host shows its group instead.
 */
export function ExternalOpenButton({
  target,
  onError,
  ...control
}: ExternalOpenButtonProps) {
  const group = useExternalOpenGroup({ target, onError });
  const host = useExternalOpenGroupHost();
  if (host) return host(group);
  return <OpenWithControl groups={[group]} {...control} />;
}
