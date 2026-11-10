(() => {
  "use strict";

  const config = window.FOP_CONFIG || {};
  const piSandbox = false;
  const piEnvironment = "testnet-production-url";
  const $ = (id) => document.getElementById(id);

  const piStatus = $("piStatus");
  const piUser = $("piUser");
  const authButtons = [$("piAuthButton"), $("piAuthButtonSecondary")].filter(Boolean);
  let piReady = false;
  let piUserData = null;
  let selectedPlan = null;
  const piDebugLog = $("piDebugLog");
  const piDebugMeta = $("piDebugMeta");
  const piDebugState = $("piDebugState");
  const debugEntries = [];

  function safeError(error) {
    if (!error) return { message: "Unknown error" };
    return {
      name: error.name || "Error",
      message: error.message || String(error),
      code: error.code ?? null,
    };
  }

  function debugLog(event, details = {}) {
    const entry = {
      time: new Date().toISOString(),
      event,
      ...details,
    };
    debugEntries.push(entry);
    if (debugEntries.length > 80) debugEntries.shift();
    if (piDebugLog) {
      piDebugLog.textContent = debugEntries
        .map((item) => {
          const detailsText = Object.fromEntries(
            Object.entries(item).filter(([key]) => key !== "time" && key !== "event")
          );
          return `${item.time} | ${item.event}${Object.keys(detailsText).length ? ` | ${JSON.stringify(detailsText)}` : ""}`;
        })
        .join("\n");
      piDebugLog.scrollTop = piDebugLog.scrollHeight;
    }
    if (details.error) {
      if (piDebugState) {
        piDebugState.textContent = "خطا ثبت شد — گزارش را برای بررسی ارسال کنید.";
        piDebugState.classList.add("error");
      }
    } else if (piDebugState) {
      piDebugState.textContent = `آخرین رویداد: ${event}`;
      piDebugState.classList.remove("error");
    }
    console.info("[FOP Pi Diagnostics]", entry);
  }

  function renderDebugMeta() {
    if (!piDebugMeta) return;
    const items = [
      ["Environment", config.ENVIRONMENT || "نامشخص"],
      ["Pi Sandbox", String(piSandbox)],
      ["Hostname", location.hostname || "نامشخص"],
      ["Protocol", location.protocol || "نامشخص"],
      ["Pi SDK object", window.Pi ? "موجود" : "موجود نیست"],
      ["Pi.authenticate", typeof window.Pi?.authenticate === "function" ? "موجود" : "موجود نیست"],
      ["Pi ready", String(piReady)],
      ["User agent", navigator.userAgent || "نامشخص"],
    ];
    piDebugMeta.replaceChildren(...items.map(([label, value]) => {
      const item = document.createElement("div");
      item.className = "pi-debug-meta-item";
      const strong = document.createElement("strong");
      strong.textContent = label;
      const span = document.createElement("span");
      span.textContent = value;
      item.append(strong, span);
      return item;
    }));
  }

  function setPiStatus(message, error = false) {
    if (!piStatus) return;
    piStatus.textContent = message;
    piStatus.classList.toggle("error", error);
  }

  function setAuthBusy(busy) {
    authButtons.forEach((button) => {
      button.disabled = busy;
      button.classList.toggle("is-loading", busy);
    });
  }

  async function initPi() {
    renderDebugMeta();
    debugLog("Pi initialization started", {
      piObjectPresent: Boolean(window.Pi),
      authenticateFunction: typeof window.Pi?.authenticate === "function",
      sandbox: piSandbox,
      environment: piEnvironment,
      hostname: location.hostname,
    });
    if (!window.Pi) {
      debugLog("Pi SDK object is missing", { error: true });
      setPiStatus("برای استفاده از قابلیت Pi، این صفحه را داخل Pi Browser باز کنید.", true);
      renderDebugMeta();
      return;
    }

    try {
      await window.Pi.init({
        version: "2.0",
        sandbox: piSandbox,
      });
      piReady = true;
      renderDebugMeta();
      debugLog("Pi.init succeeded", {
        piObjectPresent: true,
        authenticateFunction: typeof window.Pi.authenticate === "function",
        piReady: true,
      });
      setPiStatus(
        piSandbox
          ? "Pi SDK آماده است — محیط Testnet / Sandbox"
          : "Pi SDK آماده است — محیط Production"
      );
    } catch (error) {
      console.error("Pi.init failed", error);
      debugLog("Pi.init failed", { ...safeError(error), error: true });
      renderDebugMeta();
      setPiStatus("راه‌اندازی Pi انجام نشد. دوباره صفحه را باز کنید.", true);
    }
  }

  async function authenticateWithPi() {
    if (!piReady || !window.Pi) {
      debugLog("Pi authentication blocked", {
        piReady,
        piObjectPresent: Boolean(window.Pi),
        error: true,
      });
      setPiStatus("این قابلیت فقط داخل Pi Browser در دسترس است.", true);
      return;
    }

    setAuthBusy(true);
    setPiStatus("در حال احراز هویت امن با Pi...");
    debugLog("Pi authentication started", {
      piReady,
      authenticateFunction: typeof window.Pi?.authenticate === "function",
      scopes: ["username"],
    });

    try {
      const authPromise = window.Pi.authenticate(
        ["username"],
        (incompletePayment) => {
          // Payment recovery is intentionally not performed in this static frontend.
          // The authoritative recovery flow remains on the verified desktop checkout.
          console.info("Pi reported an incomplete payment:", incompletePayment?.identifier);
        }
      );

      debugLog("Pi.authenticate called", {
        returnedPromise: Boolean(authPromise && typeof authPromise.then === "function"),
      });

      if (!authPromise || typeof authPromise.then !== "function") {
        throw new Error("Pi.authenticate did not return a Promise");
      }

      const timeoutPromise = new Promise((_, reject) => {
        window.setTimeout(() => {
          reject(new Error("Pi authentication timed out"));
        }, 20000);
      });

      const auth = await Promise.race([authPromise, timeoutPromise]);

      debugLog("Pi.authenticate resolved", {
        responseKeys: auth && typeof auth === "object" ? Object.keys(auth) : [],
        userPresent: Boolean(auth?.user),
        userKeys: auth?.user && typeof auth.user === "object" ? Object.keys(auth.user) : [],
        accessTokenPresent: Boolean(auth?.accessToken),
      });

      piUserData = auth?.user || null;
      const username = piUserData?.username || "Pioneer";
      if (piUser) {
        piUser.textContent = `وارد شده‌اید: ${username}`;
        piUser.classList.remove("hidden");
      }

      authButtons.forEach((button) => {
        button.textContent = "متصل به Pi";
        button.classList.add("connected");
      });
      setPiStatus(`ورود با Pi موفق بود — ${username}`);
    } catch (error) {
      console.error("Pi.authenticate failed", error);
      debugLog("Pi.authenticate failed", { ...safeError(error), error: true });
      if (error?.message === "Pi authentication timed out") {
        debugLog("Pi authentication timeout", {
          timeoutMs: 20000,
          sandbox: piSandbox,
          environment: piEnvironment,
          error: true,
        });
        setPiStatus(
          "احراز هویت Pi پاسخ نداد. Pi Browser را باز نگه دارید و دوباره تلاش کنید.",
          true
        );
      } else {
        setPiStatus("ورود با Pi لغو شد یا با خطا مواجه شد.", true);
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function loadPlans() {
    const grid = $("pricingGrid");
    if (!grid) return;

    try {
      const response = await fetch(
        `${config.SUPABASE_URL}/rest/v1/plans?select=*&is_active=eq.true&order=display_order.asc`,
        {
          headers: {
            apikey: config.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${config.SUPABASE_ANON_KEY}`,
          },
        }
      );

      if (!response.ok) throw new Error(`plans HTTP ${response.status}`);
      const plans = await response.json();
      if (!Array.isArray(plans) || plans.length === 0) throw new Error("no plans");

      grid.replaceChildren();
      plans.forEach((plan) => {
        const card = document.createElement("article");
        card.className = "card plan-card";

        if (plan.badge) {
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = plan.badge;
          card.appendChild(badge);
        }

        const title = document.createElement("h3");
        title.textContent = plan.name || "Plan";

        const price = document.createElement("div");
        price.className = "plan-price";
        const amount = Number(plan.price_usd || 0);
        price.textContent = amount > 0 ? `$${amount.toFixed(2)}` : "رایگان";

        if (plan.duration_days) {
          const duration = document.createElement("small");
          duration.textContent =
            plan.duration_days <= 31 ? " / ماه" :
            plan.duration_days <= 186 ? " / ۶ ماه" : " / سال";
          price.appendChild(duration);
        }

        const limit = document.createElement("p");
        limit.className = "plan-limit";
        const bytes = Number(plan.organization_limit_bytes || 0);
        limit.textContent = bytes > 0
          ? `تا ${(bytes / 1024 / 1024 / 1024).toFixed(1)} گیگابایت`
          : "بدون سقف حجمی";

        const action = document.createElement("button");
        action.type = "button";
        action.className = "btn btn-primary plan-select-button";
        action.dataset.planId = String(plan.id ?? "");
        action.textContent = "انتخاب و خرید";
        action.addEventListener("click", () => selectPlan(plan));

        card.append(title, price, limit, action);
        grid.appendChild(card);
      });
    } catch (error) {
      console.error("loadPlans failed", error);
      grid.replaceChildren();
      const fallback = document.createElement("div");
      fallback.className = "card loading-card";
      fallback.textContent = "پلن‌ها در حال حاضر در دسترس نیستند. لطفاً دوباره تلاش کنید.";
      grid.appendChild(fallback);
    }
  }

  async function selectPlan(plan) {
    selectedPlan = plan;
    document.querySelectorAll(".plan-card.is-selected").forEach((card) => {
      card.classList.remove("is-selected");
    });

    const clickedButton = document.querySelector(
      `.plan-select-button[data-plan-id="${CSS.escape(String(plan.id ?? ""))}"]`
    );
    clickedButton?.closest(".plan-card")?.classList.add("is-selected");

    debugLog("Plan selected", {
      planId: plan.id ?? null,
      planName: plan.name ?? null,
      priceUsd: plan.price_usd ?? null,
    });

    if (!piUserData) {
      setPiStatus(`پلن «${plan.name || "انتخاب‌شده"}» انتخاب شد. ابتدا با Pi وارد شوید.`);
      await authenticateWithPi();
      if (!piUserData) return;
    }

    setPiStatus(
      `پلن «${plan.name || "انتخاب‌شده"}» انتخاب شد. آماده ادامه فرایند پرداخت هستید.`
    );
  }

  function wireDownload() {
    const url = config.DOWNLOAD_URL || "#";
    const button = $("downloadButton");
    const hero = $("heroDownload");
    if (button) button.href = url;
    if (hero && url !== "#") hero.href = "#download";
  }

  window.addEventListener("error", (event) => {
    debugLog("Unhandled browser error", {
      message: event.message || "Unknown browser error",
      source: event.filename || "unknown",
      line: event.lineno || null,
      column: event.colno || null,
      error: true,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    debugLog("Unhandled promise rejection", {
      ...safeError(event.reason),
      error: true,
    });
  });

  $("piDebugClear")?.addEventListener("click", () => {
    debugEntries.length = 0;
    if (piDebugLog) piDebugLog.textContent = "";
    if (piDebugState) {
      piDebugState.textContent = "گزارش پاک شد.";
      piDebugState.classList.remove("error");
    }
    debugLog("Diagnostic log cleared");
  });

  $("piDebugCopy")?.addEventListener("click", async () => {
    const text = piDebugLog?.textContent || "No diagnostics available.";
    try {
      await navigator.clipboard.writeText(text);
      if (piDebugState) piDebugState.textContent = "گزارش کپی شد.";
    } catch (error) {
      debugLog("Copy diagnostics failed", { ...safeError(error), error: true });
    }
  });

  authButtons.forEach((button) => button.addEventListener("click", authenticateWithPi));
  $("year").textContent = new Date().getFullYear();
  wireDownload();
  renderDebugMeta();
  debugLog("Page loaded", {
    href: location.href,
    referrer: document.referrer || "",
  });
  initPi();
  loadPlans();
})();
