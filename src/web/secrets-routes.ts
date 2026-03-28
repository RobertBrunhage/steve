import type { Hono } from "hono";
import { getHealth } from "../health.js";
import { refreshRuntimeConfigFromVault } from "../config.js";
import { renderDashboard, renderEditForm, renderHome, renderNewForm } from "./views.js";
import { validateSecretKey } from "./validate.js";
import { getFieldNames, getVisibleVaultKeys, mergeFieldsWithExistingValue, parseFields, RESERVED_VAULT_KEYS, valueToFields } from "./common.js";
import type { WebRouteDeps } from "./types.js";

export function registerSecretsRoutes(app: Hono, deps: WebRouteDeps) {
  app.get("/", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const health = await getHealth();
    const vault = deps.getVault();
    return c.html(renderHome(health, getVisibleVaultKeys(vault), vault ? getFieldNames(vault) : {}, session.csrfToken));
  });

  app.get("/secrets", (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;
    return c.redirect("/secrets/new");
  });

  app.get("/secrets/list", (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const vault = deps.getVault();
    return c.html(renderDashboard(getVisibleVaultKeys(vault), vault ? getFieldNames(vault) : {}, undefined, session.csrfToken));
  });

  app.get("/secrets/new", (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;
    return c.html(renderNewForm(undefined, session.csrfToken));
  });

  app.post("/secrets", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const validatedKey = validateSecretKey(String(result.body.key || ""));
    if (!validatedKey.ok) {
      return c.html(renderNewForm(validatedKey.error, result.session.csrfToken), 400);
    }
    if (RESERVED_VAULT_KEYS.has(validatedKey.value)) {
      return c.html(renderNewForm("That name is reserved for Steve internals", result.session.csrfToken), 400);
    }

    const fields = parseFields(result.body);
    if (Object.keys(fields).length === 0) {
      return c.html(renderNewForm("At least one field is required", result.session.csrfToken), 400);
    }

    vault.set(validatedKey.value, fields);
    return c.redirect("/");
  });

  app.get("/secrets/:key/edit", (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const key = decodeURIComponent(c.req.param("key"));
    const validatedKey = validateSecretKey(key);
    if (!validatedKey.ok || RESERVED_VAULT_KEYS.has(validatedKey.value)) return c.redirect("/");

    const current = vault.get(validatedKey.value) as Record<string, unknown> | string | null;
    if (!current) return c.redirect("/");
    return c.html(renderEditForm(validatedKey.value, valueToFields(validatedKey.value, current), undefined, session.csrfToken));
  });

  app.post("/secrets/:key", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const key = decodeURIComponent(c.req.param("key"));
    const validatedKey = validateSecretKey(key);
    if (!validatedKey.ok || RESERVED_VAULT_KEYS.has(validatedKey.value)) return c.redirect("/");

    const fields = parseFields(result.body);
    if (Object.keys(fields).length === 0) {
      const current = vault.get(validatedKey.value) as Record<string, unknown> | string | null;
      return c.html(renderEditForm(validatedKey.value, valueToFields(validatedKey.value, current), "At least one field is required", result.session.csrfToken), 400);
    }

    const existingValue = vault.get(validatedKey.value) as Record<string, unknown> | string | null;
    const nextValue = mergeFieldsWithExistingValue(existingValue, fields);

    if (validatedKey.value === "telegram/bot_token") {
      try {
        const res = await deps.telegramFetch(`https://api.telegram.org/bot${String(nextValue)}/getMe`);
        const data = await res.json() as { ok: boolean };
        if (!data.ok) {
          return c.html(renderEditForm(validatedKey.value, valueToFields(validatedKey.value, existingValue), "Telegram bot token looks invalid", result.session.csrfToken), 400);
        }
      } catch {
        return c.html(renderEditForm(validatedKey.value, valueToFields(validatedKey.value, existingValue), "Telegram bot token looks invalid", result.session.csrfToken), 400);
      }
    }

    vault.set(validatedKey.value, nextValue as any);
    if (validatedKey.value === "telegram/bot_token") {
      refreshRuntimeConfigFromVault(vault);
    }
    return c.redirect("/");
  });

  app.post("/secrets/:key/delete", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const key = decodeURIComponent(c.req.param("key"));
    const validatedKey = validateSecretKey(key);
    if (validatedKey.ok && !RESERVED_VAULT_KEYS.has(validatedKey.value)) {
      vault.delete(validatedKey.value);
    }
    return c.redirect("/");
  });
}
