// A friendly label for this device, sent with each book registration and shown in the account's
// over-limit chooser / cloud list so the user can tell which device imported each book.
import { Platform } from "react-native";

export function deviceLabel(): string {
  if (Platform.OS === "ios") {
    return (Platform as unknown as { isPad?: boolean }).isPad ? "iPad" : "iPhone";
  }
  if (Platform.OS === "android") return "Android";
  return "iOS";
}
