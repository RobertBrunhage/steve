// Barrel module: keeps the existing `import { ... } from "./views.js"` paths
// in route files working after the per-page split. Each page lives in
// `views/<page>.ts` next to the others; this file just re-exports the public
// surface.

export { renderHome, type MemberSummary, type RenderHomeOptions } from "./views/home.js";
export { renderSettings } from "./views/settings.js";
export { renderJobsPage, type JobsFilterStatus, type RenderJobsPageOptions } from "./views/tasks.js";
export {
  renderUserConnections,
  renderUserBrowserPage,
  renderUserIntegrationsPage,
  renderUserAgentPage,
  renderUserHeader,
  type UserPageTab,
  type RenderUserOptions,
} from "./views/members.js";
export { renderUserSecretNewForm, renderUserSecretEditForm } from "./views/integrations.js";
export { renderSetup, renderSetupComplete, renderLogin, renderSetupLocked } from "./views/auth.js";
