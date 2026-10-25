/**
 * zkapi balance - show the prepaid zkAPI private balance in ETH and USD.
 *
 * The daemon's own /admin/status only reports policy, so this reads the wallet
 * companion directly: GET <zkapi.client_url>/wallet/status with the owner-only
 * bridge token from config.json. Balance is billed in gwei (1e-9 ETH).
 *
 * Nothing secret is logged: only the balance, the note id and the two
 * precondition flags reach the transcript.
 *
 * Expiry: the note's on-chain expiry forfeits any unspent balance, so the
 * output always shows days left and escalates: warning within 14 days,
 * error within 3 days or once expired.
 *
 * Commands: /zkapi            (/zkapi usd to print only the USD figure)
 * Tools:    zkapi_balance
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GWEI_PER_ETH = 1_000_000_000;
const PRICE_TTL_MS = 60_000;
const WARN_DAYS = 14;
const URGENT_DAYS = 3;
const DAY_MS = 86_400_000;

type Source = { configDir: string; clientUrl: string; bridgeToken: string };
type Balance = {
  network: string;
  eth: number;
  depositEth: number;
  noteId: number;
  pendingRequest: boolean;
  expiry?: Date;
  daysLeft: number | null;
  usd: number | null;
  priceSource: string | null;
};

/** Now in ms; ZKAPI_NOW_OVERRIDE (epoch seconds) exists so the expiry paths are testable. */
function nowMs(): number {
  const forced = Number(process.env.ZKAPI_NOW_OVERRIDE);
  return Number.isFinite(forced) && forced > 0 ? forced * 1000 : Date.now();
}

/** info | warning | error, driven by how close the note is to forfeiting its balance. */
export function expirySeverity(daysLeft: number | null): "info" | "warning" | "error" {
  if (daysLeft === null) return "info";
  if (daysLeft < 0 || daysLeft <= URGENT_DAYS) return "error";
  if (daysLeft <= WARN_DAYS) return "warning";
  return "info";
}

function configDir(): string {
  return (
    process.env.ZKAPI_CLIENTD_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "zkapi-clientd")
  );
}

async function loadSource(): Promise<Source> {
  const dir = configDir();
  let raw: string;
  try {
    raw = await readFile(join(dir, "config.json"), "utf8");
  } catch {
    throw new Error(
      `no zkapi profile at ${dir}/config.json - run \`zkapi-clientd config\` (or set ZKAPI_CLIENTD_CONFIG_DIR)`,
    );
  }
  let cfg: any;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error(`${dir}/config.json is not valid JSON`);
  }
  const clientUrl = cfg?.zkapi?.client_url;
  const bridgeToken = cfg?.zkapi?.bridge_token;
  if (typeof clientUrl !== "string" || !clientUrl.startsWith("http://127.0.0.1")) {
    throw new Error("config.json has no loopback zkapi.client_url; re-run `zkapi-clientd config`");
  }
  if (typeof bridgeToken !== "string" || bridgeToken.length === 0) {
    throw new Error("config.json has no zkapi.bridge_token; re-run `zkapi-clientd config`");
  }
  return { configDir: dir, clientUrl, bridgeToken };
}

async function getJson<T>(url: string, token?: string): Promise<T> {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`${new URL(url).pathname} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

let priceCache: { at: number; price: number; source: string } | null = null;

async function ethUsd(): Promise<{ price: number; source: string } | null> {
  const forced = process.env.ZKAPI_ETH_USD_PRICE;
  if (forced && Number.isFinite(Number(forced))) {
    return { price: Number(forced), source: "ZKAPI_ETH_USD_PRICE" };
  }
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache;

  const sources: Array<[string, string, (b: any) => number]> = [
    [
      "coinbase",
      "https://api.coinbase.com/v2/prices/ETH-USD/spot",
      (b) => Number(b?.data?.amount),
    ],
    [
      "binance",
      "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT",
      (b) => Number(b?.price),
    ],
  ];
  for (const [source, url, pick] of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const price = pick(await res.json());
      if (Number.isFinite(price) && price > 0) {
        priceCache = { at: Date.now(), price, source };
        return priceCache;
      }
    } catch {
      /* try the next source */
    }
  }
  return null;
}

function fmtEth(v: number): string {
  return `${v.toFixed(9).replace(/0+$/, "").replace(/\.$/, "")} ETH`;
}

async function readBalance(): Promise<Balance> {
  const src = await loadSource();
  let wallet: any;
  try {
    wallet = await getJson(`${src.clientUrl}/wallet/status`, src.bridgeToken);
  } catch (e) {
    throw new Error(
      `${(e as Error).message} - is zkapi-clientd running? (\`systemctl --user status zkapi-clientd\`)`,
    );
  }
  if (!wallet?.has_note || !wallet?.note) {
    throw new Error("wallet has no active private note - fund it with `zkapi-clientd config`");
  }
  const meta = await getJson<any>(`${src.clientUrl}/oa/v1/status`, src.bridgeToken).catch(() => null);
  const gwei = Number(wallet.note.current_balance);
  if (!Number.isFinite(gwei)) throw new Error("wallet/status returned no numeric current_balance");

  const eth = gwei / GWEI_PER_ETH;
  const px = await ethUsd();
  const expiry = Number(wallet.note.expiry_ts);
  const expiryDate = Number.isFinite(expiry) && expiry > 0 ? new Date(expiry * 1000) : undefined;
  return {
    network: meta?.chain_id === 11155111 ? "sepolia" : "mainnet",
    eth,
    depositEth: Number(wallet.note.deposit_amount) / GWEI_PER_ETH,
    noteId: Number(wallet.note.note_id),
    pendingRequest: Boolean(wallet.pending_request),
    expiry: expiryDate,
    daysLeft: expiryDate ? (expiryDate.getTime() - nowMs()) / DAY_MS : null,
    usd: px ? eth * px.price : null,
    priceSource: px?.source ?? null,
  };
}

function summary(b: Balance): string {
  const usd = b.usd === null ? "USD unavailable (no price source)" : `≈ $${b.usd.toFixed(2)}`;
  const spent = b.depositEth - b.eth;
  const lines = [
    `zkapi ${b.network} balance: ${fmtEth(b.eth)} ${usd}`,
    `note #${b.noteId} · deposited ${fmtEth(b.depositEth)} · spent ${fmtEth(spent)}`,
  ];
  if (b.pendingRequest) lines.push("warning: a request is pending settlement");
  if (b.expiry && b.daysLeft !== null) {
    const date = b.expiry.toISOString().slice(0, 10);
    if (b.daysLeft < 0) {
      lines.push(`EXPIRED ${date}: unspent balance is no longer claimable - contact the zkAPI operator`);
    } else if (b.daysLeft <= URGENT_DAYS) {
      lines.push(`EXPIRES IN ${Math.floor(b.daysLeft)}d (${date}) - withdraw now; the balance is forfeited after that`);
    } else if (b.daysLeft <= WARN_DAYS) {
      lines.push(`expires in ${Math.floor(b.daysLeft)}d (${date}) - withdraw before then or lose the rest`);
    } else {
      lines.push(`expires ${date} (${Math.floor(b.daysLeft)}d left) - unspent balance is forfeited after that`);
    }
  }
  if (b.priceSource) lines.push(`ETH/USD from ${b.priceSource}`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "zkapi_balance",
      label: "zkapi balance",
      description:
        "Read the local zkAPI prepaid private balance (ETH and USD) from the wallet companion. Use when asked how much zkAPI credit is left.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const b = await readBalance();
          return {
            content: [{ type: "text", text: summary(b) }],
            details: { ...b, expiry: b.expiry?.toISOString() },
            structuredContent: {
              eth: b.eth,
              usd: b.usd,
              network: b.network,
              noteId: b.noteId,
              pendingRequest: b.pendingRequest,
              daysLeft: b.daysLeft === null ? null : Math.floor(b.daysLeft),
            },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `zkapi balance unavailable: ${(e as Error).message}` }],
            details: undefined,
            isError: true,
          };
        }
      },
    }),
  );

  pi.registerCommand("zkapi", {
    description: "Show the zkAPI private balance in ETH and USD (/zkapi usd for USD only)",
    handler: async (args, ctx) => {
      try {
        const b = await readBalance();
        const arg = args.trim().toLowerCase();
        if (arg === "usd") {
          ctx.ui.notify(
            b.usd === null ? "USD unavailable (no price source)" : `$${b.usd.toFixed(2)}`,
            "info",
          );
          return;
        }
        if (arg === "eth") {
          ctx.ui.notify(fmtEth(b.eth), "info");
          return;
        }
        const level = expirySeverity(b.daysLeft) === "info" && b.pendingRequest ? "warning" : expirySeverity(b.daysLeft);
        ctx.ui.notify(summary(b), level);
      } catch (e) {
        ctx.ui.notify(`zkapi balance unavailable: ${(e as Error).message}`, "error");
      }
    },
  });
}

export const __test = { readBalance, summary, fmtEth, configDir };
