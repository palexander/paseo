import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  conversationHostPreflight,
  useConversationHostPreflight,
} from "@/runtime/conversation-host";

export function HostPreflightStatus({ serverId }: { serverId: string }) {
  const state = useConversationHostPreflight(serverId);
  const { t } = useTranslation();
  const pending = state?.phase !== "failed";
  const onPress = useCallback(() => {
    if (pending) conversationHostPreflight.cancel(serverId);
    else conversationHostPreflight.dismiss(serverId);
  }, [pending, serverId]);
  if (!state) return null;
  return (
    <View
      style={styles.container}
      accessibilityRole={pending ? "summary" : "alert"}
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.message}>{state.message}</Text>
      {!pending && <Text style={styles.hint}>{t("hostPreflight.retryHint")}</Text>}
      <Button
        variant="ghost"
        size="sm"
        accessibilityLabel={pending ? t("hostPreflight.cancel") : t("common.actions.dismiss")}
        onPress={onPress}
        style={styles.action}
      >
        {pending ? t("hostPreflight.cancel") : t("common.actions.dismiss")}
      </Button>
      {pending && <Text style={styles.hint}>{t("hostPreflight.cancelHint")}</Text>}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  container: { padding: 12, gap: 8, borderRadius: 8, backgroundColor: theme.colors.surface1 },
  message: { color: theme.colors.foreground, fontSize: 13 },
  hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
  action: { alignSelf: "flex-start", paddingVertical: 4, paddingHorizontal: 6 },
  actionText: { color: theme.colors.foreground, fontSize: 12 },
}));
