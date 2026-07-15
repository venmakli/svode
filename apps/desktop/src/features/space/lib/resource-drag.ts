import {
  serializeSvodeDraggedResource,
  SVODE_RESOURCE_MIME,
  type SvodeDraggedResource,
} from "../model/resource-drag";

export function writeSvodeResourceDragData(
  dataTransfer: DataTransfer,
  resource: SvodeDraggedResource,
): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(
    SVODE_RESOURCE_MIME,
    serializeSvodeDraggedResource(resource),
  );
}
