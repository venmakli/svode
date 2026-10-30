import { SpaceConfigAlert, useSpace } from "@/features/space";

// Settings of the project and of every space whose config cannot be read stay
// hidden; one warning per such owner tells why above every section.
export function SpaceConfigAlerts() {
  const { rootSpaces, activeRootId, spaces } = useSpace();
  const project = rootSpaces.find((space) => space.id === activeRootId);
  const owners = [
    ...(project?.configUnreadable ? [project] : []),
    ...spaces.filter((space) => space.configUnreadable),
  ];
  if (owners.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {owners.map((space) => (
        <SpaceConfigAlert
          key={space.id}
          space={space}
          owner={space.id === activeRootId ? "project" : "space"}
        />
      ))}
    </div>
  );
}
