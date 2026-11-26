/**
 * XR正道官衙遺跡 — メインアプリケーションロジック
 * 機能: タブ遷移 / テーマ切替 / Leaflet GPSマップ & ジオフェンス /
 *       model-viewer (.glb + .usdz AR) / Sketchfab遺物3D / 発掘Canvas / おまけAR（郡司と記念撮影）
 */
(function () {
  const CFG = window.XR_CONFIG;
  const STORAGE_KEY = "xr_shodo_kanga_state_v1";

  const state = loadState();
  let map = null;
  let userMarker = null;
  let userCoords = null;
  let watchId = null;
  let restorationOverlay = null;
  let excavationOverlay = null;
  let tileOSM = null;
  let tileSat = null;
  let mapLayers = { restoration: false, excavation: false, satellite: false };
  let pinMarkers = {};
  let currentModelTab = "buildings";
  let quoteIndex = 0;
  let helpIndex = 0;
  let helpReturnView = "home";
  let activeViewId = "home";
  let viewerReturnView = "models";

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      theme: "indigo",
      fontSize: "normal",
      sound: true,
      visitedBuildings: [],
      dugSpots: []
    };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}

    updateProgressUI();
  }

  // Haversine 距離計算（メートル）
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // 1. 画面遷移
  function showView(viewId) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("is-active"));
    const target = document.getElementById(`view-${viewId}`);
    if (target) target.classList.add("is-active");

    // ボトムナビ同期
    activeViewId = viewId;
    const tabMap = { home: "home", map: "map", models: "models", viewer: "models", help: "help", menu: "menu", about: "home", omake: "home" };
    const activeTab = tabMap[viewId] || "home";
    document.querySelectorAll(".nav-tab").forEach((btn) => {
      const tab = btn.dataset.tab;
      const isAct = tab === activeTab;
      btn.classList.toggle("is-active", isAct);
    });

    if (viewId === "map") {
      initMapIfNeeded();
      setTimeout(() => map && map.invalidateSize(), 120);
    }
    if (viewId === "omake") {
      renderOmakeView();
    }
  }

  // "#22345e" → "rgba(34, 52, 94, 0.18)"
  function hexToRgba(hex, alpha) {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  // 紺で描かれたSVGアイコン（<img>）を、色をテーマ色で塗れるインラインSVGに置き換える
  function inlineAccentSvg(img) {
    if (!img || !window.fetch) return;
    fetch(img.src)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((text) => {
        if (!img.isConnected) return;
        const span = document.createElement("span");
        span.className = img.className;
        span.setAttribute("role", "img");
        span.setAttribute("aria-label", img.alt || "");
        span.innerHTML = text.replace(/#1b314f/gi, "currentColor");
        img.replaceWith(span);
      })
      .catch(() => {});
  }

  // 2. テーマ適用
  function applyTheme(themeId) {
    const theme = CFG.themes.find((t) => t.id === themeId) || CFG.themes[0];
    state.theme = theme.id;
    // ボタン・選択中表示・紺のアイコンなどの基調色をテーマ色に合わせる
    const root = document.documentElement;
    root.style.setProperty("--accent", theme.color);
    root.style.setProperty("--border-subtle", hexToRgba(theme.color, 0.18));
    const homeEl = document.getElementById("view-home");
    if (homeEl) homeEl.style.backgroundImage = `url("${theme.bg}")`;
    if (theme.headerBg) {
      document.querySelectorAll(".sub-header").forEach((hdr) => {
        hdr.style.backgroundImage = `url("${theme.headerBg}")`;
      });
    }
    if (theme.homeLogo) {
      const homeLogoEl = document.querySelector(".home-logo-img");
      if (homeLogoEl) homeLogoEl.src = theme.homeLogo;
    }
    document.querySelectorAll(".theme-swatch-btn").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.theme === theme.id);
    });
    saveState();
  }

  // 2b. 文字サイズ切替（標準／大）
  function applyFontSize(size) {
    const valid = size === "large" ? "large" : "normal";
    state.fontSize = valid;
    document.body.classList.toggle("font-large", valid === "large");
    document.querySelectorAll(".font-size-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.fontSize === valid);
    });
    saveState();
  }

  // 3. 進捗UI更新
  function updateProgressUI() {
    const count = state.visitedBuildings.length;
    const total = CFG.buildings.length;
    const unlocked = count >= total;
    const ov = document.getElementById("home-progress-overlay");
    if (ov) {
      ov.textContent = `体験スタンプ ${count}/${total}棟`;
      ov.classList.toggle("is-unlocked", unlocked);
    }
    const spText = document.getElementById("settings-progress-text");
    if (spText) {
      spText.textContent = unlocked
        ? `現在の鑑賞状況：${count} / ${total}棟（お楽しみ解放済み）`
        : `現在の鑑賞状況：${count} / ${total}棟`;
    }
    const otBtn = document.getElementById("btn-home-otanoshimi");
    const otImg = document.getElementById("img-home-otanoshimi");
    if (otBtn && otImg) {
      otBtn.disabled = !unlocked;
      otBtn.setAttribute("aria-disabled", String(!unlocked));
      otBtn.classList.toggle("is-locked", !unlocked);
      otImg.src = unlocked ? CFG.omake.bannerUnlocked : CFG.omake.bannerLocked;
      otImg.alt = unlocked ? "お楽しみ" : "お楽しみ（解放前）";
    }
    renderModelGrid();
    refreshMapPinIcons();
  }

  // 4. 3Dモデル鑑賞画面（建物5棟 / 遺物3点）
  function renderModelGrid() {
    const grid = document.getElementById("model-grid");
    if (!grid) return;
    grid.innerHTML = "";

    if (currentModelTab === "buildings") {
      const intro = document.createElement("details");
      intro.className = "cg-intro-box";
      intro.style.gridColumn = "1 / -1";
      intro.innerHTML = `
        <summary class="serif">官衙Ⅲ期建物群の3DCG復元（タップで開く）</summary>
        <p style="margin:8px 0 6px;">発掘調査で見つかる柱の痕跡「柱穴（ちゅうけつ）」の配置と、現存する古代の寺院建築や絵巻などの史料、早川和子氏による復元イラストを参考に3DCGで復元しました。</p>
        <p style="margin:0 0 8px;">正道官衙遺跡で見つかった建物はすべて地面に掘った穴に柱を埋める掘立柱建物で、瓦葺きのような重い屋根を支えられないため板葺きや檜皮葺きが採用されたと考えられます。中心の「身舎（もや）」と周囲の「庇（ひさし）」の配置から、庁屋は入母屋造り、副屋・向屋・東屋は切妻造り、南門は八脚門として復元しています。</p>
      `;
      grid.appendChild(intro);
      CFG.buildings.forEach((b) => {
        const visited = state.visitedBuildings.includes(b.id);
        const card = document.createElement("button");
        card.className = "model-card";
        card.innerHTML = `
          <img class="model-card-thumb" src="${b.thumb}" alt="${b.name}">
          <div class="model-card-body">
            <p class="model-card-title serif">${b.name}（${b.kana}）</p>
            <p class="model-card-sub">${b.role}</p>
            ${visited ? '<span class="badge-done">体験済み</span>' : ""}
          </div>
        `;
        card.addEventListener("click", () => openBuildingViewer(b));
        grid.appendChild(card);
      });
    } else {
      CFG.artifacts.forEach((a) => {
        const card = document.createElement("button");
        card.className = "model-card";
        card.innerHTML = `
          <img class="model-card-thumb" src="${a.thumb}" alt="${a.name}">
          <div class="model-card-body">
            <p class="model-card-title serif">${a.name}</p>
            <p class="model-card-sub">${a.subtitle}</p>
          </div>
        `;
        card.addEventListener("click", () => openArtifactViewer(a));
        grid.appendChild(card);
      });
    }
  }

  function markBuildingVisited(id) {
    if (!state.visitedBuildings.includes(id)) {
      state.visitedBuildings.push(id);
      saveState();
    }
  }

  // 建物3D（3D鑑賞ではAR一切なし／マップ経由のときのみ床面ARを表示）
  function openBuildingViewer(b) {
    const fromMap = activeViewId === "map";
    viewerReturnView = fromMap ? "map" : "models";
    markBuildingVisited(b.id);
    document.getElementById("viewer-title").textContent = `${b.name}（${b.kana}）`;
    const body = document.getElementById("viewer-body");
    const arAttrs = fromMap
      ? `ios-src="${b.usdz}" ar ar-modes="webxr scene-viewer quick-look"`
      : "";
    const arButtonHtml = fromMap
      ? `<button slot="ar-button" class="ar-launch-btn">
            <img src="./assets/images/icons/icon_ar.svg" alt="">
            <span>ARで見る</span>
          </button>`
      : "";
    const noteText = fromMap
      ? "ドラッグで回転・ピンチで拡大縮小できます。対応スマホでは右下の「ARで見る」から床面に配置できます。"
      : "ドラッグで回転・ピンチで拡大縮小できます。";
    body.innerHTML = `
      <div class="viewer-full-stage">
        <model-viewer
          src="${b.glb}"
          ${arAttrs}
          poster="${b.thumb}"
          alt="${b.name} 復元3Dモデル"
          camera-controls
          auto-rotate
          shadow-intensity="1"
          exposure="1.05"
        >
          ${arButtonHtml}
        </model-viewer>
      </div>
      <div class="viewer-plain-body">
        <p class="viewer-plain-note">${noteText}</p>
        <h3 class="serif">${b.name} — ${b.role}</h3>
        <p>${b.description}</p>
      </div>
    `;
    body.scrollTop = 0;
    showView("viewer");
  }

  // 遺物3D（Sketchfab 全幅ページで開き、戻るボタンで戻る）
  function openArtifactViewer(a) {
    viewerReturnView = activeViewId === "map" ? "map" : "models";
    document.getElementById("viewer-title").textContent = a.name;
    const body = document.getElementById("viewer-body");
    body.innerHTML = `
      <div class="viewer-full-sketchfab">
        <iframe
          title="${a.name}（正道官衙遺跡）"
          frameborder="0"
          allowfullscreen
          mozallowfullscreen="true"
          webkitallowfullscreen="true"
          allow="autoplay; fullscreen; xr-spatial-tracking"
          xr-spatial-tracking
          execution-while-out-of-viewport
          execution-while-not-rendered
          web-share
          src="https://sketchfab.com/models/${a.sketchfabUid}/embed"
        ></iframe>
      </div>
      <div class="viewer-plain-body">
        <p class="sketchfab-credit">
          <a href="${a.modelUrl}" target="_blank" rel="noopener noreferrer">${a.name}（正道官衙遺跡）</a>
          by <a href="${a.authorUrl}" target="_blank" rel="noopener noreferrer">${a.authorName}</a> on Sketchfab
        </p>
        <h3 class="serif">${a.name}</h3>
        <p>${a.description}</p>
      </div>
    `;
    body.scrollTop = 0;
    showView("viewer");
  }

  // 5. マップ画面（Leaflet + GPS + レイヤー切替）
  function createPinIcon(imgPath) {
    const url = imgPath && !imgPath.startsWith("data:") && !imgPath.includes("?v=")
      ? `${imgPath}?v=20261121d`
      : imgPath;
    return L.icon({
      iconUrl: url,
      iconSize: [42, 49],
      iconAnchor: [21, 48]
    });
  }

  function initMapIfNeeded() {
    if (map) return;
    map = L.map("leaflet-map", {
      zoomControl: false,
      attributionControl: true
    }).setView([CFG.siteCenter.lat, CFG.siteCenter.lng], CFG.siteCenter.zoom);

    tileOSM = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20,
      attribution: "&copy; OpenStreetMap contributors"
    }).addTo(map);

    // 国土地理院 航空写真タイル（無料・APIキー不要・GitHub Pages対応）
    tileSat = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", {
      maxZoom: 18,
      attribution: "国土地理院"
    });

    restorationOverlay = L.imageOverlay(
      "./assets/images/map/overlay_restoration.png",
      CFG.overlayBounds.restoration,
      { opacity: 1.0 }
    );

    excavationOverlay = L.imageOverlay(
      "./assets/images/map/overlay_excavation.png",
      CFG.overlayBounds.excavation,
      { opacity: 0.95 }
    );

    // 建物ピン5棟
    CFG.buildings.forEach((b) => {
      const done = state.visitedBuildings.includes(b.id);
      const marker = L.marker([b.lat, b.lng], {
        icon: createPinIcon(done ? b.pinDone : b.pin)
      }).addTo(map);
      marker.on("click", () => openSpotSheet("building", b));
      pinMarkers[b.id] = marker;
    });


    // 体験（ウォークスルー）開始ピン：タップで確認モーダル → はい で即遷移
    (CFG.vrSpots || []).forEach((v) => {
      const marker = L.marker([v.lat, v.lng], {
        icon: createPinIcon(v.pin),
        zIndexOffset: 400
      }).addTo(map);
      marker.on("click", () => {
        showConfirm(
          v.name || "ウォークスルー体験",
          "この場所からのウォークスルー体験を開始しますか？",
          () => {
            if (window.__IS_CANVAS_PREVIEW) {
              showAlert("プレビュー環境", `GitHub Pages公開版では「準備中」画面を経て、この地点（${v.id}）からウォークスルー体験へ直接遷移します。`);
              return;
            }
            window.location.href = `./vr/index.html?camera=${encodeURIComponent(v.id)}`;
          }
        );
      });
    });


    const vrGpsBtn = document.getElementById("btn-map-vr-gps");
    if (vrGpsBtn && !vrGpsBtn.dataset.bound) {
      vrGpsBtn.dataset.bound = "1";
      vrGpsBtn.addEventListener("click", () => {
        showConfirm(
          "現在地からウォークスルー",
          "現在地とカメラの向きに合わせてウォークスルー体験を開始しますか？",
          () => {
            if (window.__IS_CANVAS_PREVIEW) {
              showAlert("プレビュー環境", "GitHub Pages公開版では、現在地（GPS）とカメラの向きに合わせたウォークスルー体験へ遷移します。");
              return;
            }
            window.location.href = "./vr/index.html?mode=gps";
          }
        );
      });
    }

    map.on("click", () => closeSpotSheet());
    startGpsWatch();
  }

  function refreshMapPinIcons() {
    if (!map) return;
    CFG.buildings.forEach((b) => {
      const m = pinMarkers[b.id];
      if (!m) return;
      const done = state.visitedBuildings.includes(b.id);
      m.setIcon(createPinIcon(done ? b.pinDone : b.pin));
    });
  }

  function launchFloorArImmediate(b) {
    markBuildingVisited(b.id);
    if (window.__IS_CANVAS_PREVIEW) {
      showAlert("プレビュー環境", `GitHub Pages公開版では、${b.name}の床面AR（iOS: ARクイックルック / Android: Scene Viewer）が直接起動します。`);
      return;
    }
    const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (isIOS && b.usdz && !b.usdz.startsWith("data:")) {
      const iosLink = document.getElementById("spot-ar-ios-link");
      if (iosLink) {
        iosLink.setAttribute("href", b.usdz);
        iosLink.click();
        return;
      }
    }
    if (isAndroid && b.glb && !b.glb.startsWith("data:")) {
      const absGlb = new URL(b.glb, window.location.href).href;
      const intentUrl = `intent://arvr.google.com/scene-viewer/1.0?file=${encodeURIComponent(absGlb)}&mode=ar_preferred&title=${encodeURIComponent(b.name)}#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;end;`;
      window.location.href = intentUrl;
      return;
    }
    showAlert("AR起動について", "「ここでAR」はAR対応スマートフォン（iOS Safari / Android Chrome）で直接カメラARが起動します。");
  }

  function launchGpsBuildingAr(b) {
    markBuildingVisited(b.id);
    if (window.__IS_CANVAS_PREVIEW) {
      showAlert("プレビュー環境", `GitHub Pages公開版では、GPS＋スマホ向き連動の現地AR画面（${b.name}）へ遷移します。`);
      return;
    }
    window.location.href = `./ar/index.html?building=${encodeURIComponent(b.id)}`;
  }

  function updateOnSiteVrButton() {
    const btn = document.getElementById("btn-map-vr-gps");
    if (!btn || !userCoords) return;
    const radius = (CFG.siteGeoTransform && CFG.siteGeoTransform.siteRadiusMeters) || 200;
    const dist = distanceMeters(userCoords.lat, userCoords.lng, CFG.siteCenter.lat, CFG.siteCenter.lng);
    btn.classList.toggle("hidden", dist > radius);
  }

  function startGpsWatch() {
    if (!("geolocation" in navigator)) return;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (map) {
          if (!userMarker) {
            userMarker = L.marker([userCoords.lat, userCoords.lng], {
              icon: createPinIcon("./assets/images/map/pin_user.svg")
            }).addTo(map);
          } else {
            userMarker.setLatLng([userCoords.lat, userCoords.lng]);
          }
        }
        updateOnSiteVrButton();
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
  }

  function openSpotSheet(type, data) {
    const sheet = document.getElementById("map-spot-sheet");
    document.getElementById("spot-sheet-title").textContent = data.name;
    let meta = "";
    if (userCoords) {
      const d = Math.round(distanceMeters(userCoords.lat, userCoords.lng, data.lat, data.lng));
      meta = `現在地から約 ${d}m`;
    } else {
      meta = "どこからでも3D・AR体験できます";
    }
    document.getElementById("spot-sheet-meta").textContent = meta;
    document.getElementById("spot-sheet-desc").textContent = data.description;

    const actBtn = document.getElementById("spot-sheet-action");
    actBtn.textContent = "ここでAR";
    actBtn.onclick = () => {
      closeSpotSheet();
      launchFloorArImmediate(data);
    };
    const gpsArBtn = document.getElementById("spot-sheet-gps-ar");
    if (gpsArBtn) {
      gpsArBtn.onclick = () => {
        closeSpotSheet();
        launchGpsBuildingAr(data);
      };
    }
    sheet.classList.add("is-open");
  }

  function closeSpotSheet() {
    document.getElementById("map-spot-sheet").classList.remove("is-open");
  }

  // 7. おまけ画面（統一：建物5棟コンプリートで gunji.glb / gunji.usdz AR記念撮影解放）
  function renderOmakeView() {
    const container = document.getElementById("omake-stage");
    const unlocked = state.visitedBuildings.length >= CFG.buildings.length;
    const omake = CFG.omake;

    const checklistHtml = CFG.buildings
      .map((b) => {
        const done = state.visitedBuildings.includes(b.id);
        return `<span style="display:inline-block;margin:3px;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:700;background:${done ? "#2e7a4a" : "#d8d3c8"};color:${done ? "#fff" : "#5a5e6b"};">${b.name}${done ? " ✓" : ""}</span>`;
      })
      .join("");

    if (unlocked) {
      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const isAndroid = /Android/i.test(navigator.userAgent);

      container.innerHTML = `
        <div class="info-card" style="width:100%;text-align:center;">
          <h3 class="serif">${omake.title}</h3>
          <p style="font-size:12.5px;line-height:1.6;margin-bottom:14px;">${omake.description}</p>

          <!-- 郡司＋カメラアイコン タップでネイティブAR起動（iOSのARバッジ重なり防止のため rel="ar" は非表示リンク経由） -->
          <button type="button" id="omake-ar-trigger" class="omake-ar-trigger" aria-label="郡司をタップしてAR起動">
            <img src="${omake.triggerImg}" alt="久世郡司" class="omake-ar-gunji">
            <img src="${omake.cameraIcon}" alt="カメラ" class="omake-ar-camera">
          </button>
          <a id="omake-ar-ios-link" rel="ar" href="${omake.usdz}" style="position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;" tabindex="-1" aria-hidden="true">
            <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="">
          </a>
          <p style="margin:10px 0 4px;font-size:13px;font-weight:700;color:var(--accent);">
            郡司をタップしてAR起動（記念撮影）
          </p>
        </div>
        <div style="text-align:center;">${checklistHtml}</div>
      `;

      inlineAccentSvg(container.querySelector(".omake-ar-camera"));

      const triggerEl = document.getElementById("omake-ar-trigger");
      triggerEl.addEventListener("click", (ev) => {
        ev.preventDefault();
        if (isIOS && !omake.usdz.startsWith("data:")) {
          const iosLink = document.getElementById("omake-ar-ios-link");
          if (iosLink) iosLink.click();
          return;
        }
        if (isAndroid && !omake.glb.startsWith("data:")) {
          const absGlb = new URL(omake.glb, window.location.href).href;
          const intentUrl = `intent://arvr.google.com/scene-viewer/1.0?file=${encodeURIComponent(absGlb)}&mode=ar_preferred&title=${encodeURIComponent(omake.title)}#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;end;`;
          window.location.href = intentUrl;
        } else {
          showAlert("ネイティブAR起動について", "iPhone（Safari）ではARクイックルック、Android（Chrome）ではScene Viewerが直接起動します。GitHub Pages公開URLからスマートフォンでお試しください。");
        }
      });
    } else {
      const remain = CFG.buildings.length - state.visitedBuildings.length;
      container.innerHTML = `
        <img class="reward-card-img" style="width:86%;max-width:320px;" src="${omake.lockedImg}" alt="おまけ解放前">
        <div class="info-card" style="width:100%;">
          <h3 class="serif">${omake.title}</h3>
          <p>復元建物5棟をすべて鑑賞すると、久世郡司の3Dモデル（<code>gunji.glb</code> / <code>gunji.usdz</code>）をARで呼び出して一緒に記念撮影ができるようになります。</p>
          <p style="font-weight:700;color:#9f3328;">あと ${remain} 棟の鑑賞で解放！</p>
          <div style="margin-top:8px;">${checklistHtml}</div>
        </div>
        <button class="primary-btn" style="width:100%;" id="btn-omake-to-models">3Dモデル鑑賞で建物を見る</button>
      `;
      document.getElementById("btn-omake-to-models").addEventListener("click", () => showView("models"));
    }
  }

  // 8. ヘルプ画面（ページ遷移型）
  function renderHelpSlide() {
    const slide = CFG.helpSlides[helpIndex];
    document.getElementById("help-slide-img").src = slide.img;
    document.getElementById("help-slide-title").textContent = slide.title;
    document.getElementById("help-slide-text").textContent = slide.text;
    const dots = document.getElementById("help-dots");
    dots.innerHTML = CFG.helpSlides
      .map((_, i) => `<button type="button" class="help-dot ${i === helpIndex ? "is-active" : ""}" data-help-dot="${i}" aria-label="スライド${i + 1}"></button>`)
      .join("");
    dots.querySelectorAll("[data-help-dot]").forEach((dotBtn) => {
      dotBtn.addEventListener("click", () => {
        helpIndex = Number(dotBtn.dataset.helpDot);
        renderHelpSlide();
      });
    });
  }

  // 汎用アラートモーダル
  function showAlert(title, message) {
    document.getElementById("alert-title").textContent = title;
    document.getElementById("alert-message").textContent = message;
    document.getElementById("modal-alert").classList.add("is-open");
  }

  // はい／いいえ確認モーダル
  function showConfirm(title, message, onYes) {
    const modal = document.getElementById("modal-confirm");
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-message").textContent = message;
    const yesBtn = document.getElementById("btn-confirm-yes");
    const noBtn = document.getElementById("btn-confirm-no");
    yesBtn.onclick = () => {
      modal.classList.remove("is-open");
      if (typeof onYes === "function") onYes();
    };
    noBtn.onclick = () => modal.classList.remove("is-open");
    modal.classList.add("is-open");
  }

  // 初期化・イベントバインド
  function init() {
    const splashEl = document.getElementById("splash-screen");
    if (splashEl) {
      // トップ画面は click でだけ閉じる（touchend / pointerup で閉じると、
      // 直後のクリックが裏のホーム画面のボタンに届いてしまうため）
      let splashGuardUntil = 0;
      const dismissSplash = (e) => {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        splashGuardUntil = Date.now() + 400;
        splashEl.classList.add("is-hidden");
      };
      splashEl.addEventListener("click", dismissSplash);
      // 閉じた直後0.4秒間は、裏の画面へのクリックを受け付けない
      document.addEventListener("click", (e) => {
        if (Date.now() < splashGuardUntil && !splashEl.contains(e.target)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
      splashEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          dismissSplash();
        }
      });
    }

    // テーマスウォッチ生成
    const swWrap = document.getElementById("theme-swatches");
    CFG.themes.forEach((t) => {
      const btn = document.createElement("button");
      btn.className = "theme-swatch-btn";
      btn.dataset.theme = t.id;
      btn.setAttribute("aria-label", t.label);
      btn.title = t.label;
      btn.innerHTML = `<span class="theme-swatch-dot" style="background:${t.color};"></span>`;
      btn.addEventListener("click", () => applyTheme(t.id));
      swWrap.appendChild(btn);
    });
    applyTheme(state.theme);

    // 文字サイズ切替（標準／大）
    document.querySelectorAll(".font-size-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyFontSize(btn.dataset.fontSize));
    });
    applyFontSize(state.fontSize || "normal");

    // 郡司セリフ前後切替（1/4⇔4/4 ループ禁止）
    const prevBtn = document.getElementById("btn-quote-prev");
    const nextBtn = document.getElementById("btn-quote-next");
    const renderQuote = () => {
      document.getElementById("home-speech-text").textContent = CFG.gunjiQuotes[quoteIndex];
      const pager = document.getElementById("home-speech-pager");
      if (pager) pager.textContent = `${quoteIndex + 1} / ${CFG.gunjiQuotes.length}`;
      if (prevBtn) prevBtn.disabled = quoteIndex <= 0;
      if (nextBtn) nextBtn.disabled = quoteIndex >= CFG.gunjiQuotes.length - 1;
    };
    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        if (quoteIndex > 0) { quoteIndex--; renderQuote(); }
      });
    }
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        if (quoteIndex < CFG.gunjiQuotes.length - 1) { quoteIndex++; renderQuote(); }
      });
    }
    renderQuote();

    // ナビゲーション＆バナーボタン
    document.querySelectorAll("[data-goto]").forEach((el) => {
      el.addEventListener("click", () => showView(el.dataset.goto));
    });
    const viewerBackBtn = document.getElementById("btn-viewer-back");
    if (viewerBackBtn) {
      viewerBackBtn.addEventListener("click", () => {
        document.getElementById("viewer-body").innerHTML = "";
        showView(viewerReturnView || "models");
      });
    }

    // 3Dモデル鑑賞タブ切替
    document.querySelectorAll(".segment-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentModelTab = btn.dataset.modelTab;
        document.querySelectorAll(".segment-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
        renderModelGrid();
      });
    });

    // マップレイヤー切替
    document.getElementById("btn-layer-cg").addEventListener("click", (e) => {
      mapLayers.restoration = !mapLayers.restoration;
      e.currentTarget.classList.toggle("is-on", mapLayers.restoration);
      if (restorationOverlay) {
        mapLayers.restoration ? restorationOverlay.addTo(map) : map.removeLayer(restorationOverlay);
      }
    });
    document.getElementById("btn-layer-dig").addEventListener("click", (e) => {
      mapLayers.excavation = !mapLayers.excavation;
      e.currentTarget.classList.toggle("is-on", mapLayers.excavation);
      if (excavationOverlay) {
        mapLayers.excavation ? excavationOverlay.addTo(map) : map.removeLayer(excavationOverlay);
      }
    });
    document.getElementById("btn-layer-sat").addEventListener("click", (e) => {
      mapLayers.satellite = !mapLayers.satellite;
      e.currentTarget.classList.toggle("is-on", mapLayers.satellite);
      if (map) {
        if (mapLayers.satellite) {
          map.removeLayer(tileOSM);
          tileSat.addTo(map);
        } else {
          map.removeLayer(tileSat);
          tileOSM.addTo(map);
        }
      }
    });
    document.getElementById("btn-map-gps").addEventListener("click", () => {
      if (!map) return;
      if (userCoords) {
        map.setView([userCoords.lat, userCoords.lng], 18);
      } else {
        map.setView([CFG.siteCenter.lat, CFG.siteCenter.lng], CFG.siteCenter.zoom);
      }
    });

    // ヘルプ画面遷移
    document.querySelectorAll(".js-open-help").forEach((b) => {
      b.addEventListener("click", () => {
        if (activeViewId && activeViewId !== "help") {
          helpReturnView = activeViewId;
        }
        helpIndex = 0;
        renderHelpSlide();
        showView("help");
      });
    });
    const helpBackBtn = document.getElementById("btn-help-back");
    if (helpBackBtn) {
      helpBackBtn.addEventListener("click", () => {
        showView(helpReturnView || "home");
      });
    }
    document.getElementById("btn-help-prev").addEventListener("click", () => {
      helpIndex = (helpIndex - 1 + CFG.helpSlides.length) % CFG.helpSlides.length;
      renderHelpSlide();
    });
    document.getElementById("btn-help-next").addEventListener("click", () => {
      helpIndex = (helpIndex + 1) % CFG.helpSlides.length;
      renderHelpSlide();
    });

    // モーダル閉じる
    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.closeModal;
        document.getElementById(id).classList.remove("is-open");
        if (id === "modal-viewer") document.getElementById("viewer-body").innerHTML = "";
      });
    });

    document.getElementById("btn-reset-progress").addEventListener("click", () => {
      state.visitedBuildings = [];
      state.dugSpots = [];
      saveState();
      showAlert("リセット完了", "体験スタンプをリセットしました。");
    });

    const showSplashBtn = document.getElementById("btn-show-splash");
    if (showSplashBtn) {
      showSplashBtn.addEventListener("click", () => {
        // トップ画面の裏でホームに切り替えておき、タップで閉じたらホームが出るようにする
        showView("home");
        const sp = document.getElementById("splash-screen");
        if (sp) sp.classList.remove("is-hidden");
      });
    }


    // 図1: 官衙Ⅰ〜Ⅲ期 DEMタップ切替（Ⅰ→Ⅱ→Ⅲ→Ⅰ）
    const demStage = document.getElementById("kanga-dem-stage");
    if (demStage) {
      const periods = [
        { idx: 1, label: "官衙Ⅰ期（7世紀後半）" },
        { idx: 2, label: "官衙Ⅱ期（7世紀末〜8世紀初め）" },
        { idx: 3, label: "官衙Ⅲ期（8世紀初め〜9世紀前半）" }
      ];
      let pCur = 0;
      const applyPeriod = () => {
        const p = periods[pCur];
        [1, 2, 3].forEach((n) => {
          const el = document.getElementById(`kanga-dem-layer-${n}`);
          if (el) el.classList.toggle("is-visible", n === p.idx);
        });
        const cap = document.getElementById("kanga-dem-caption");
        if (cap) cap.innerHTML = `図1　官衙Ⅰ〜Ⅲ期の変遷イメージ<br>（表示中：${p.label}）`;
      };
      demStage.addEventListener("click", () => {
        pCur = (pCur + 1) % periods.length;
        applyPeriod();
      });
      applyPeriod();
    }

    updateProgressUI();
    if (window.location.hash === "#map") {
      document.getElementById("splash-screen").classList.add("is-hidden");
      showView("map");
    } else {
      showView("home");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
