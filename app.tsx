// bb-plugin-instabox frontend entry: the InstaBox page in bb's sidebar and the
// machine-provider inputs control.
//
// Compiled by `bb plugin build` into dist/app.js + app.css. React and
// @get-bb/plugin-sdk/app come from the bb app at load time. All InstaBox data
// and actions go through the server's typed RPC (src/dashboard.ts); this
// bundle never sees the API key or any connection credential.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { InstaboxPage, useInstaboxBadge } from "./ui/InstaboxPage.tsx";
import { InstaboxMachineInputs } from "./ui/MachineInputs.tsx";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "instabox",
    title: "InstaBox",
    // Unknown icon names fall back to the plugin branding (instabox.svg).
    icon: "Boxes",
    path: "instabox",
    component: InstaboxPage,
    experimental_useBadge: useInstaboxBadge,
  });
  app.slots.experimental_machineProviderInputs({ machineProviderId: "instabox", component: InstaboxMachineInputs });
});
