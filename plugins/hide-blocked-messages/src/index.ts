// @description Hides messages from users you blocked or ignored
// @version 0.1.0
// @author mai

const { gateway } = phoenix;

const BLOCKED = 2;
const AUTO_MODERATION_ACTION = 24;

const settings = phoenix.settings.define({
  hideBlocked: {
    type: "switch",
    title: "Hide blocked users",
    description: "Remove messages from users you blocked instead of collapsing them",
    default: true,
  },
  hideIgnored: {
    type: "switch",
    title: "Hide ignored users",
    description: "Remove messages from users you ignored",
    default: true,
  },
  hideReplies: {
    type: "switch",
    title: "Hide replies to them",
    description: "Also remove messages that reply to a hidden user",
    default: false,
  },
  keepAutoMod: {
    type: "switch",
    title: "Keep AutoMod messages",
    description: "Let AutoMod alerts about these users through",
    default: true,
  },
});

/// Relationship object, docs.discord.food resources/relationships. Gateway updates are partial.
interface Relationship {
  id: string;
  type?: number;
  user_ignored?: boolean;
}

const blocked = new Set<string>();
const ignored = new Set<string>();
let loaded = false;
let loading = false;

const apply = (rel: Relationship) => {
  if (rel.type !== undefined) {
    if (rel.type === BLOCKED) blocked.add(rel.id);
    else blocked.delete(rel.id);
  }
  if (rel.user_ignored !== undefined) {
    if (rel.user_ignored) ignored.add(rel.id);
    else ignored.delete(rel.id);
  }
};

// READY carries the relationships but skips the gateway registry, so they are read from the API.
const load = async () => {
  if (loaded || loading) return;
  loading = true;
  try {
    const res = await phoenix.discord.get("/users/@me/relationships");
    if (!res.ok) return;
    const list = res.json<Relationship[]>();
    if (!Array.isArray(list)) return;
    blocked.clear();
    ignored.clear();
    for (const rel of list) if (rel?.id) apply({ ...rel, user_ignored: rel.user_ignored === true });
    loaded = true;
    phoenix.log.info(`hiding ${blocked.size} blocked and ${ignored.size} ignored users`);
  } catch {
    // Rejects until the app has made a request of its own; the next message retries.
  } finally {
    loading = false;
  }
};

const relationshipEvents: (Phoenix.Sig<unknown> | undefined)[] = [
  gateway.relationshipAdd,
  gateway.relationshipUpdate,
];
for (const sig of relationshipEvents) {
  if (sig) phoenix.on(sig as Phoenix.Sig<Relationship>, (rel) => rel?.id && apply(rel));
}
if (gateway.relationshipRemove) {
  phoenix.on(gateway.relationshipRemove as Phoenix.Sig<Relationship>, (rel) => {
    if (!rel?.id) return;
    blocked.delete(rel.id);
    ignored.delete(rel.id);
  });
}
phoenix.on(gateway.ready, () => {
  loaded = false;
  void load();
});
void load();

const hiddenUser = (id: string | undefined) =>
  id !== undefined &&
  ((settings.hideBlocked && blocked.has(id)) || (settings.hideIgnored && ignored.has(id)));

const byHidden = (message: Phoenix.Message | null | undefined) =>
  !!message && (hiddenUser(message.author?.id) || hiddenUser(message.interaction?.user?.id));

const hidden = (message: Phoenix.Message) => {
  if (message.type === AUTO_MODERATION_ACTION && settings.keepAutoMod) return false;
  return byHidden(message) || (settings.hideReplies && byHidden(message.referenced_message));
};

const drop = {
  before(message: Phoenix.GatewayMessage) {
    if (!loaded) void load();
    return hidden(message) ? false : undefined;
  },
};
phoenix.hook(gateway.messageCreate, drop);
phoenix.hook(gateway.messageUpdate, drop);

// History comes from the API, not the gateway. A filtered page comes back shorter than asked for.
phoenix.discord.onResponse({ method: "GET", pathPrefix: "/channels/", pathSuffix: "/messages" }, (res) => {
  if (!loaded) void load();
  if (res.status !== 200 || (blocked.size === 0 && ignored.size === 0)) return;
  const messages = res.json<Phoenix.Message[]>();
  if (!Array.isArray(messages)) return;
  const kept = messages.filter((m) => !hidden(m));
  if (kept.length !== messages.length) return { body: kept };
});
