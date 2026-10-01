import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import { i18n } from "./lib/i18n";
import { createNotivue } from "notivue";
import "notivue/notification.css";
import "notivue/animations.css";
createApp(App)
  .use(i18n)
  .use(
    createNotivue({
      position: "top-right",
      limit: 3,
      enqueue: false,
      avoidDuplicates: true,
      notifications: {
        global: { duration: 6000 },
        error: { duration: 10000, ariaRole: "alert", ariaLive: "assertive" },
        warning: { duration: 10000 },
        promise: { duration: Infinity },
      },
    }),
  )
  .mount("#app");
