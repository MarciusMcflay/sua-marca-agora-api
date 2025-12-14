import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

/* =====================
   PROTEÇÕES DE PROCESSO
===================== */

// NÃO deixa o processo morrer silenciosamente
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// Evita shutdown imediato do Render
process.on("SIGTERM", () => {
  console.warn("SIGTERM recebido — mantendo processo vivo");
});

/* =====================
   CONFIG
===================== */

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) {
  console.error("Missing INTERNAL_API_TOKEN");
}

const SUPABASE_PROJECT_URL =
  process.env.SUPABASE_PROJECT_URL || "";

const PORT = Number(process.env.PORT || 10000);

/* =====================
   APP
===================== */

const app = express();
app.use(express.json({ limit: "200kb" }));

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origin === SUPABASE_PROJECT_URL) return cb(null, true);
      return cb(null, false);
    },
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
  })
);

// Health checks — ESSENCIAL pro Render
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

// Token gate
app.use((req, res, next) => {
  if (req.method === "GET") return next();
  if (req.method === "OPTIONS") return res.sendStatus(204);

  if (req.header("X-Internal-Token") !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

/* =====================
   PUPPETEER
===================== */

async function fetchInpiHtmlByMarca(marca) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  try {
    const page = await browser.newPage();

    await page.goto("https://busca.inpi.gov.br/pePI/", {
      waitUntil: "domcontentloaded",
    });

    await page.goto(
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
      { waitUntil: "domcontentloaded" }
    );

    await page.goto(
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
      { waitUntil: "domcontentloaded" }
    );

    await page.waitForSelector('input[name="marca"]', { timeout: 15000 });
    await page.click('input[name="marca"]', { clickCount: 3 });
    await page.type('input[name="marca"]', marca);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('input[name="botao"]'),
    ]);

    return await page.content();
  } finally {
    await browser.close();
  }
}

/* =====================
   ROUTE
===================== */

app.post("/consulta-inpi", async (req, res) => {
  try {
    const marca = String(req.body?.marca || "").trim();
    if (marca.length < 2) {
      return res.status(400).json({ error: "Invalid marca" });
    }

    const html = await fetchInpiHtmlByMarca(marca);
    res.json({ ok: true, marca, html });
  } catch (e) {
    console.error("Consulta error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =====================
   START
===================== */

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});

// Mantém o event loop vivo (Render-friendly)
setInterval(() => {}, 1000);
