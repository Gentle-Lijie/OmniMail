import { serverMessage } from "./i18n.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { id, hash, type Store } from "./store.js";
export function configureAuth(
  app: FastifyInstance,
  store: Store,
  origin: string,
  setupToken: string,
) {
  const rpID = new URL(origin).hostname;
  const secure = origin.startsWith("https:");
  const { db } = store;
  const count = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM passkeys").get() as any).n;
  const load = (req: FastifyRequest): any => {
    const sid = (req as any).cookies?.omnimail;
    if (!sid) return null;
    const row = db
      .prepare("SELECT value FROM sessions WHERE id=? AND expiresAt>?")
      .get(hash(sid), Date.now()) as any;
    return row ? JSON.parse(row.value) : null;
  };
  const session = (req: FastifyRequest, reply: any, authenticated = false) => {
    const token = id();
    const value = { csrfToken: id(), authenticated };
    if ((req as any).cookies?.omnimail)
      db.prepare("DELETE FROM sessions WHERE id=?").run(
        hash((req as any).cookies.omnimail),
      );
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(
      hash(token),
      JSON.stringify(value),
      Date.now() + 86400000,
    );
    reply.setCookie("omnimail", token, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/",
      maxAge: 86400,
    });
    return value;
  };
  const persist = (req: FastifyRequest, value: any) =>
    db
      .prepare("UPDATE sessions SET value=? WHERE id=?")
      .run(JSON.stringify(value), hash((req as any).cookies.omnimail));
  const attempts = new Map<string, { n: number; until: number }>();
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const incoming = req.headers.origin;
    if (incoming && incoming !== origin)
      return reply
        .code(403)
        .send({ error: serverMessage("auth.originNotAllowed") });
    if (req.url.startsWith("/api/auth/")) {
      if (req.method === "POST") {
        const now = Date.now();
        let a = attempts.get(req.ip);
        if (!a || a.until < now) {
          a = { n: 0, until: now + 60000 };
          attempts.set(req.ip, a);
        }
        if (++a.n > 30)
          return reply.code(429).send({
            error: serverMessage("auth.tooManyAuthenticationAttempts"),
          });
        if (attempts.size > 10000) attempts.clear();
      }
      return;
    }
    const s = load(req);
    if (!s?.authenticated)
      return reply
        .code(401)
        .send({ error: serverMessage("auth.passkeyLoginRequired") });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers["x-csrf-token"] !== s.csrfToken
    )
      return reply
        .code(403)
        .send({ error: serverMessage("auth.invalidCSRFToken") });
  });
  app.get("/api/auth/status", async (req, reply) => {
    db.prepare("DELETE FROM sessions WHERE expiresAt<?").run(Date.now());
    const s = load(req) ?? session(req, reply);
    return {
      authenticated: s.authenticated,
      csrfToken: s.csrfToken,
      needsSetup: count() === 0,
      registrationEnabled: store.get("registrationEnabled", true),
    };
  });
  app.post("/api/auth/register/options", async (req, reply) => {
    const body = req.body as any;
    let s = load(req);
    const initial = count() === 0;
    const tokenOk =
      !!setupToken &&
      typeof body?.setupToken === "string" &&
      hash(body.setupToken) === hash(setupToken);
    if (initial) {
      if (!tokenOk)
        return reply
          .code(403)
          .send({ error: serverMessage("auth.validSetupTokenRequired") });
    } else if (
      !tokenOk &&
      (!s?.authenticated || !store.get("registrationEnabled", true))
    )
      return reply.code(403).send({
        error: serverMessage("auth.passkeyRegistrationDisabledOrLoginRequired"),
      });
    if (!s) s = session(req, reply);
    const options = await generateRegistrationOptions({
      rpName: "OmniMail",
      rpID,
      userName: "OmniMail workspace",
      userID: new TextEncoder().encode("omnimail-shared-workspace"),
      attestationType: "none",
      excludeCredentials: (
        db.prepare("SELECT id FROM passkeys").all() as any[]
      ).map((r) => ({ id: r.id })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    s.challenge = options.challenge;
    s.purpose = "register";
    s.initial = initial;
    s.tokenAuthorized = tokenOk;
    s.challengeExpires = Date.now() + 300000;
    if (req.cookies.omnimail) persist(req, s);
    else {
      const cookie = reply.getHeader("set-cookie") as
        string | string[] | undefined;
      const token = (Array.isArray(cookie) ? cookie[0] : cookie)?.match(
        /omnimail=([^;]+)/,
      )?.[1];
      if (token)
        db.prepare("UPDATE sessions SET value=? WHERE id=?").run(
          JSON.stringify(s),
          hash(token),
        );
    }
    return options;
  });
  app.post("/api/auth/register/verify", async (req, reply) => {
    const s = load(req);
    if (
      !s ||
      s.purpose !== "register" ||
      s.challengeExpires < Date.now() ||
      (!s.initial && !s.authenticated && !s.tokenAuthorized) ||
      (s.initial && count() > 0)
    )
      return reply
        .code(403)
        .send({ error: serverMessage("auth.registrationChallengeExpired") });
    const challenge = s.challenge;
    delete s.challenge;
    s.purpose = null;
    persist(req, s);
    const body = req.body as any;
    const result = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo)
      throw new Error(serverMessage("auth.passkeyVerificationFailed"));
    if (s.initial && count() > 0)
      throw new Error(serverMessage("auth.workspaceAlreadyInitialized"));
    const c = result.registrationInfo.credential;
    db.prepare("INSERT INTO passkeys VALUES (?,?,?,?)").run(
      c.id,
      String(body.name || "Passkey").slice(0, 100),
      JSON.stringify({
        ...c,
        publicKey: Buffer.from(c.publicKey).toString("base64"),
      }),
      new Date().toISOString(),
    );
    store.audit("passkey.registered");
    session(req, reply, true);
    return { verified: true };
  });
  app.post("/api/auth/login/options", async (req, reply) => {
    let s = load(req);
    if (!s) s = session(req, reply);
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
    });
    s.challenge = options.challenge;
    s.purpose = "login";
    s.challengeExpires = Date.now() + 300000;
    if (req.cookies.omnimail) persist(req, s);
    else {
      const cookie = reply.getHeader("set-cookie") as
        string | string[] | undefined;
      const token = (Array.isArray(cookie) ? cookie[0] : cookie)?.match(
        /omnimail=([^;]+)/,
      )?.[1];
      if (token)
        db.prepare("UPDATE sessions SET value=? WHERE id=?").run(
          JSON.stringify(s),
          hash(token),
        );
    }
    return options;
  });
  app.post("/api/auth/login/verify", async (req, reply) => {
    const s = load(req);
    if (!s || s.purpose !== "login" || s.challengeExpires < Date.now())
      return reply
        .code(403)
        .send({ error: serverMessage("auth.loginChallengeExpired") });
    const challenge = s.challenge;
    delete s.challenge;
    s.purpose = null;
    persist(req, s);
    const response = (req.body as any).response;
    const row = db
      .prepare("SELECT credential FROM passkeys WHERE id=?")
      .get(response.id) as any;
    if (!row) throw new Error(serverMessage("auth.unknownPasskey"));
    const c = JSON.parse(row.credential);
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { ...c, publicKey: Buffer.from(c.publicKey, "base64") },
      requireUserVerification: true,
    });
    if (!result.verified) throw new Error(serverMessage("auth.loginFailed"));
    c.counter = result.authenticationInfo.newCounter;
    db.prepare("UPDATE passkeys SET credential=? WHERE id=?").run(
      JSON.stringify(c),
      response.id,
    );
    session(req, reply, true);
    store.audit("passkey.login");
    return { verified: true };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    const s = load(req);
    if (!s || req.headers["x-csrf-token"] !== s.csrfToken)
      return reply
        .code(403)
        .send({ error: serverMessage("auth.invalidCSRFToken") });
    db.prepare("DELETE FROM sessions WHERE id=?").run(
      hash(req.cookies.omnimail!),
    );
    reply.clearCookie("omnimail", { path: "/" });
    return { ok: true };
  });
  app.get("/api/passkeys", async () =>
    db.prepare("SELECT id,name,createdAt FROM passkeys").all(),
  );
  app.delete<{ Params: { id: string } }>("/api/passkeys/:id", async (req) => {
    if (count() <= 1)
      throw new Error(serverMessage("auth.cannotDeleteTheLastPasskey"));
    db.prepare("DELETE FROM passkeys WHERE id=?").run(req.params.id);
    store.audit("passkey.removed");
    return { ok: true };
  });
  return { load };
}
