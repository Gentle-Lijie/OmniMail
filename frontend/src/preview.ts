import { createApp } from "vue";
import MailPreviewPage from "./components/MailPreviewPage.vue";
import { i18n } from "./lib/i18n";
import "./style.css";

createApp(MailPreviewPage).use(i18n).mount("#app");
