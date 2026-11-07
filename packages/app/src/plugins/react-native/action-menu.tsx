import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useCallback, useMemo, useState } from "react";
import { Fragment } from "react";
import type { ActionMenuProps } from "@getpaseo/plugin/client/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ActionMenu({
  title,
  leading,
  items,
  onSelect,
  onError,
  disabled,
  loading,
}: ActionMenuProps) {
  const [pending, setPending] = useState(false);
  const toast = useToast();
  const triggerLeading = useMemo(
    () => (pending || loading ? <ThemedSpinner size="small" uniProps={spinnerMapping} /> : leading),
    [pending, loading, leading],
  );
  const choose = useCallback(
    (id: string) => {
      setPending(true);
      void (async () => {
        try {
          await onSelect(id);
        } catch (error) {
          if (onError) onError(error);
          else toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setPending(false);
        }
      })();
    },
    [onSelect, onError, toast],
  );
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownTrigger
        accessibilityLabel={title}
        disabled={disabled || pending || loading}
        leading={triggerLeading}
      >
        {title}
      </DropdownTrigger>
      <DropdownMenuContent align="end" width={240} sheetTitle={title}>
        {items.map((item, index) => (
          <Fragment key={item.id}>
            {index > 0 && item.separatorBefore ? <DropdownMenuSeparator /> : null}
            <ActionItem item={item} choose={choose} />
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function ActionItem({
  item,
  choose,
}: {
  item: ActionMenuProps["items"][number];
  choose(id: string): void;
}) {
  const select = useCallback(() => choose(item.id), [choose, item.id]);
  return (
    <DropdownMenuItem leading={item.leading} disabled={item.disabled} onSelect={select}>
      {item.title}
    </DropdownMenuItem>
  );
}
