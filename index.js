import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

/* =======================
   ENV / CONFIG
======================= */
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;
if (!INTERNAL_API_TOKEN) {
  throw new Error("Missing INTERNAL_API_TOKEN env var");
}

const SUPABASE_PROJECT_URL =
  process.env.SUPABASE_PROJECT_URL ||
  "https://mqnvfjteuwqbomvbmyhd.supabase.co";

const PORT = Number(process.env.PORT || 10000);

/* =======================
   APP
======================= */
const app = express();
app.use(express.json({ limit: "200kb" }));

/* =======================
   CORS (defensivo)
======================= */
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server
      if (origin === SUPABASE_PROJECT_URL) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Internal-Token"],
  })
);

/* =======================
   HEALTH (Render precisa)
======================= */
app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).json({ ok: true }));

/* =======================
   AUTH GATE
======================= */
app.use((req, res, next) => {
  if (req.method === "GET") return next();
  if (req.method === "OPTIONS") return res.sendStatus(204);

  const token = req.header("X-Internal-Token");
  if (token !== INTERNAL_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
});

/* =======================
   PUPPETEER CORE
======================= */
async function fetchInpiHtmlByMarca(marca) {
  console.log("[INPI] Launching browser...");

  const browser = await puppeteer.launch({
    headless: "new",

    // 🔥 ESSENCIAL NO RENDER
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36"
    );

    page.on("requestfailed", (r) =>
      console.warn("[requestfailed]", r.url(), r.failure()?.errorText)
    );

    page.on("pageerror", (e) =>
      console.error("[pageerror]", e.message)
    );

    console.log("[INPI] Step 1 – Home");
    await page.goto("https://busca.inpi.gov.br/pePI/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    console.log("[INPI] Step 2 – Login anônimo");
    await page.goto(
      "https://busca.inpi.gov.br/pePI/servlet/LoginController?action=login",
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );

    console.log("[INPI] Step 3 – Página de busca");
    await page.goto(
      "https://busca.inpi.gov.br/pePI/jsp/marcas/Pesquisa_classe_basica.jsp",
      { waitUntil: "domcontentloaded", timeout: 30000 }
    );

    console.log("[INPI] Step 4 – Preencher formulário");
    await page.waitForSelector('input[name="marca"]', { timeout: 20000 });
    await page.click('input[name="marca"]', { clickCount: 3 });
    await page.type('input[name="marca"]', marca, { delay: 20 });

    console.log("[INPI] Step 5 – Submeter");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
      page.click('input[name="botao"]'),
    ]);

    const html = await page.content();
    console.log("[INPI] HTML length:", html.length);

    return html;
  } finally {
    console.log("[INPI] Closing browser");
    await browser.close();
  }
}

/* =======================
   API
======================= */
app.post("/consulta-inpi", async (req, res) => {
  try {
    const marca = String(req.body?.marca || "").trim();
    console.log("[API] Consulta marca:", marca);

    if (!marca || marca.length < 2) {
      return res.status(400).json({ ok: false, error: "Invalid 'marca'" });
    }

    const html = await fetchInpiHtmlByMarca(marca);

    return res.json({ ok: true, marca, html });
  } catch (e) {
    console.error("[API ERROR]", e);
    return res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error",
    });
  }
});

/* =======================
   START (NÃO MORRE)
======================= */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`INPI API running on port ${PORT}`);
});

/* =======================
   SIGTERM HANDLING
======================= */
process.on("SIGTERM", () => {
  console.log("SIGTERM received – keeping container healthy");
});
