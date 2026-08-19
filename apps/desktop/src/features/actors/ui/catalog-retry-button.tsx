import { Button } from "@/components/ui/button";

export function CatalogRetryButton({
  disabled,
  label,
  onRetry,
}: {
  disabled: boolean;
  label: string;
  onRetry(): void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onRetry}
    >
      {label}
    </Button>
  );
}
