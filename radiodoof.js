/* DJ Doof: la app de RadioDoof. Le habla solo a servidor.py de dj-doof (no a Jarvis), así que reiniciar Jarvis no corta la radio.

   El reproductor viene de la sección Radio de DoofApp (static/radio.js), con lo aprendido allí:
   · 17 nov 2026: Chrome en Android se queda mudo sin disparar 'error' cuando el túnel corta. Se vigila que el audio avance y se
     reintenta sin tope mientras Javier quiera escuchar.
   · 17 nov 2026: con la app oculta, la pantalla de bloqueo cambia de canción justo a tiempo (fin_estimado + siguiente) y el estado se
     recarga cada 45 s.
   · Un salto hecho en otro lado (DoofApp, Telegram) cambia la marca `salto`: se vuelve a conectar para no oír los 30 s viejos. */

(() => {
  'use strict';

  const REPO = 'javierigc07-debug/radiodoof';
  const URL_DIRECCION = `https://api.github.com/repos/${REPO}/contents/tunel.json?ref=tunel`;
  const PATRON_TUNEL = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;
  const ES_REMOTO = location.hostname.endsWith('.github.io');
  const REFRESCO_VISIBLE_MS = 10000;
  const REFRESCO_OCULTO_MS = 45000;
  const ESPERA_MAX_REINTENTO_MS = 10000;
  const SILENCIO_MAX_MS = 10000;
  const CONECTANDO_MAX_MS = 20000;
  const ICONO = new URL('iconos/icono-512.png', location.href).href;

  const S = {
    token: guardado('doof_token'),          // el mismo que DoofApp: misma página de GitHub, mismo almacenamiento
    base: ES_REMOTO ? guardado('radiodoof_base') : '',
    datos: null,
    quiereSonar: false,
    cargando: false,
    intento: 0,
    reintentos: 0,
    reconexion: 0,
    conectandoDesde: 0,
    ultimoTiempo: -1,
    ultimoAvance: 0,
    saltoVisto: null,
    ahorro: guardado('doof_radio_ahorro') === '1',
    relojCambio: 0,
    relojEstado: 0,
  };
  const audio = new Audio();
  audio.preload = 'none';

  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const minSeg = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const I = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L8.5 4.64A1 1 0 0 0 7 5.5z"/></svg>',
    pausa: '<svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  };

  function guardado(clave) { try { return localStorage.getItem(clave) || ''; } catch (e) { return ''; } }
  function guardar(clave, valor) { try { if (valor) localStorage.setItem(clave, valor); else localStorage.removeItem(clave); } catch (e) { /* dura la sesión */ } }

  // ---------------------------------------------------------------- encontrar la PC
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // AES-GCM con una clave del token: si abre, la dirección la publicó quien tiene el token (tunel.py), aunque el repo sea público.
  async function abrirSobre(sobre) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(S.token), 'PBKDF2', false, ['deriveKey']);
    const clave = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(sobre.sal), iterations: sobre.iteraciones },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const claro = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(sobre.iv) }, clave, b64(sobre.cifrado));
    const datos = JSON.parse(new TextDecoder().decode(claro));
    if (!PATRON_TUNEL.test(datos.url)) throw new Error('dirección inválida');
    return datos.url;
  }

  async function leerDireccion() {
    const r = await fetch(`${URL_DIRECCION}&_=${Date.now()}`, { headers: { Accept: 'application/vnd.github.raw' }, cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error('GitHub respondió ' + r.status);
    return abrirSobre(await r.json());
  }

  function sobreDelEnlace() {
    const m = location.hash.match(/^#s=(.+)$/);
    if (!m) return null;
    history.replaceState(null, '', location.pathname);
    try { return JSON.parse(atob(decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { return null; }
  }

  async function salud(base) {
    try {
      const r = await fetch(base + '/api/salud', { headers: { 'X-Doof-Token': S.token }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const d = await r.json();
      return d.app === 'radiodoof' ? d : null;
    } catch (e) { return null; }
  }

  async function encontrarPC() {
    if (!ES_REMOTO) return true;
    const sobre = sobreDelEnlace();
    if (sobre) { try { S.base = await abrirSobre(sobre); guardar('radiodoof_base', S.base); } catch (e) { /* sigue con lo publicado */ } }
    if (S.base && await salud(S.base)) return true;
    try {
      const url = await leerDireccion();
      if (await salud(url)) { S.base = url; guardar('radiodoof_base', url); return true; }
    } catch (e) {
      if (e.name === 'OperationError') { entrar('Ese token no abre la dirección de RadioDoof.'); return false; }
    }
    return false;
  }

  async function api(ruta, opciones = {}, ms = 20000) {
    const r = await fetch(S.base + '/api' + ruta, {
      ...opciones, cache: 'no-store', signal: AbortSignal.timeout(ms),
      headers: { 'X-Doof-Token': S.token, ...(opciones.body ? { 'Content-Type': 'application/json' } : {}), ...(opciones.headers || {}) },
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) { entrar('Ese token ya no sirve.'); throw new Error('no autorizado'); }
    if (!r.ok) throw new Error(d.error || 'error ' + r.status);
    return d;
  }

  // ---------------------------------------------------------------- estado
  async function cargar() {
    clearTimeout(S.relojEstado);
    try {
      const d = await api('/estado');
      const antes = S.datos;
      S.datos = d;
      avisoRed('');
      // Un salto hecho en otro lado: lo que este <audio> bajó es de la canción vieja.
      if (antes && d.salto && d.salto !== antes.salto && d.salto !== S.saltoVisto) {
        S.saltoVisto = d.salto;
        if (S.quiereSonar && !S.cargando) { S.reintentos = 0; conectar(); }
      }
      pintar();
      sesionMedia();
    } catch (e) {
      if (e.message !== 'no autorizado') {
        avisoRed('Sin conexión con la PC: sigo intentando…');
        if (ES_REMOTO && !(await salud(S.base))) await encontrarPC();
      }
    }
    S.relojEstado = setTimeout(cargar, document.hidden ? REFRESCO_OCULTO_MS : REFRESCO_VISIBLE_MS);
  }

  function avisoRed(texto) {
    const el = $('estado-red');
    el.hidden = !texto;
    el.textContent = texto;
  }

  // ---------------------------------------------------------------- escuchar
  async function conectar() {
    const intento = ++S.intento;
    const vigente = () => intento === S.intento && S.quiereSonar;
    S.cargando = true;
    S.conectandoDesde = Date.now();
    pintarPlay();
    try {
      const pase = await api('/pase', { method: 'POST', body: JSON.stringify({ baja: S.ahorro }) });
      if (!vigente()) return;
      audio.src = S.base + pase.ruta;
      await audio.play();
    } catch (e) {
      if (!vigente()) return;
      if (e && e.name === 'NotAllowedError') { S.quiereSonar = false; }      // Android bloquea el play() sin un toque: que lo dé Javier
      else { S.cargando = false; reconectar(); }
    } finally {
      if (vigente()) S.cargando = false;
      pintarPlay();
      sesionMedia();
    }
  }

  function cancelarReconexion() { clearTimeout(S.reconexion); S.reconexion = 0; }

  function reconectar(inmediato) {
    if (!S.quiereSonar) return;
    if (S.reconexion) { if (!inmediato) return; cancelarReconexion(); }
    S.reintentos += 1;
    if (S.reintentos > 3) avisoRed('Se cortó el audio: sigo intentando…');
    const espera = inmediato ? 0 : Math.min(1500 * S.reintentos, ESPERA_MAX_REINTENTO_MS);
    S.reconexion = setTimeout(() => { S.reconexion = 0; if (S.quiereSonar) conectar(); }, espera);
  }

  function play() { S.quiereSonar = true; S.reintentos = 0; cancelarReconexion(); conectar(); }

  // Una emisión pausada un rato ya no tiene conexión del otro lado: reanudar es volver a conectar, al vivo.
  function pausa() {
    S.quiereSonar = false;
    S.intento += 1;
    cancelarReconexion();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    pintarPlay();
  }

  async function saltar() {
    const b = $('b-saltar');
    b.disabled = true;
    try {
      const d = await api('/saltar', { method: 'POST', body: '{}' });
      if (d && d.salto) S.saltoVisto = d.salto;
      if (S.quiereSonar) { S.reintentos = 0; conectar(); }
      cargar();
    } catch (e) { cabinaRespuesta('No pude saltar: ' + e.message, true); }
    finally { b.disabled = false; }
  }

  audio.addEventListener('error', () => { if (S.quiereSonar && !S.cargando) reconectar(); });
  audio.addEventListener('ended', () => { if (S.quiereSonar) reconectar(); });
  audio.addEventListener('playing', () => {
    S.reintentos = 0; S.ultimoAvance = Date.now();
    avisoRed('');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    pintarPlay();
  });

  // El vigilante: sonando sin avanzar, o conectando demasiado, es un stream muerto que no avisó.
  setInterval(() => {
    const ahora = Date.now();
    if (!S.quiereSonar || S.reconexion) { S.ultimoAvance = ahora; return; }
    if (S.cargando) {
      if (ahora - S.conectandoDesde > CONECTANDO_MAX_MS) { S.intento += 1; S.cargando = false; reconectar(true); }
      return;
    }
    if (audio.paused) { S.ultimoAvance = ahora; return; }       // lo pausó el sistema (una llamada)
    if (audio.currentTime !== S.ultimoTiempo) { S.ultimoTiempo = audio.currentTime; S.ultimoAvance = ahora; return; }
    if (ahora - S.ultimoAvance > SILENCIO_MAX_MS) { S.ultimoAvance = ahora; reconectar(true); }
  }, 3000);
  window.addEventListener('online', () => { if (S.quiereSonar) reconectar(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    cargar();
    if (S.quiereSonar && !S.cargando && !audio.paused && audio.readyState < 3) reconectar(true);
  });

  // ---------------------------------------------------------------- pantalla de bloqueo
  function sesionMedia(forzada) {
    if (!('mediaSession' in navigator) || !S.datos) return;
    const d = S.datos;
    const c = forzada || { titulo: d.titulo, artista: d.artista };
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: c.titulo || 'RadioDoof',
        artist: c.artista ? `${c.artista} · RadioDoof` : 'RadioDoof',
        album: d.programa ? '🎙 ' + d.programa : 'DJ Doof',
        artwork: [{ src: ICONO, sizes: '512x512', type: 'image/png' }],
      });
    } catch (e) { /* navegador sin MediaMetadata */ }
    programarCambio();
  }

  // Con la app oculta, a la hora en que termina la canción la pantalla de bloqueo ya muestra la siguiente; después se confirma.
  function programarCambio() {
    clearTimeout(S.relojCambio);
    const d = S.datos;
    if (!d || !d.fin_estimado) return;
    const ms = d.fin_estimado * 1000 - Date.now() + 1200;
    if (ms <= 0 || ms > 20 * 60 * 1000) return;
    S.relojCambio = setTimeout(() => {
      if (!S.quiereSonar) return;
      if (S.datos && S.datos.siguiente) sesionMedia({ titulo: S.datos.siguiente.titulo, artista: S.datos.siguiente.artista });
      cargar();
    }, ms);
  }

  if ('mediaSession' in navigator) {
    const accion = (n, fn) => { try { navigator.mediaSession.setActionHandler(n, fn); } catch (e) { /* no soportada */ } };
    accion('play', play);
    accion('pause', pausa);
    accion('stop', pausa);
    accion('nexttrack', saltar);
  }

  // ---------------------------------------------------------------- pintar
  function pintarPlay() {
    const b = $('b-play');
    const sonando = S.quiereSonar && !audio.paused && !S.cargando;
    b.innerHTML = S.quiereSonar ? I.pausa : I.play;
    b.setAttribute('aria-label', S.quiereSonar ? 'Pausar' : 'Escuchar');
    b.classList.toggle('cargando', S.quiereSonar && S.cargando);
    $('plato').classList.toggle('gira', sonando);
    $('radio').classList.toggle('sonando', sonando);
    $('al-aire').hidden = !sonando;
  }

  function pintar() {
    const d = S.datos;
    if (!d) return;
    $('voz').hidden = !d.bumper;
    $('titulo').textContent = d.titulo || 'RadioDoof';
    const extra = d.programa ? `🎙 ${esc(d.programa)}` : d.pedido ? `a pedido: ${esc(d.pedido)}` : d.familia ? esc(d.familia) : '';
    $('artista').innerHTML = esc(d.artista || '') + (extra ? ` · <em>${extra}</em>` : '');
    $('sigue').innerHTML = d.siguiente ? `Sigue: <b>${esc(d.siguiente.titulo)}</b> · ${esc(d.siguiente.artista)}` : 'Tu música, mezclada por Doof';
    const m = d.voz_saldo;
    const saldo = $('saldo');
    saldo.textContent = m ? `🎙 Voz: ${m.saldo.toFixed(2)} · ~${m.especiales} especiales` : '';
    saldo.classList.toggle('bajo', !!m && m.saldo < 0.15);
    moverBarra();
  }

  function moverBarra() {
    const d = S.datos;
    const caja = $('progreso');
    if (!d || !d.fin_estimado || !d.duracion || d.bumper) { caja.hidden = true; return; }
    caja.hidden = false;
    const queda = d.fin_estimado - Date.now() / 1000;
    $('progreso-barra').style.width = `${Math.min(100, Math.max(0, (1 - queda / d.duracion) * 100))}%`;
    $('progreso-texto').textContent = queda > 0 ? `${minSeg(d.duracion - queda)} / ${minSeg(d.duracion)}` : 'terminando…';
  }
  setInterval(() => { if (!document.hidden) moverBarra(); }, 1000);

  // ---------------------------------------------------------------- la cabina
  function cabinaRespuesta(texto, mal) {
    const el = $('cabina-respuesta');
    el.hidden = !texto;
    el.textContent = texto;
    el.classList.toggle('mal', !!mal);
  }

  $('cabina-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const campo = $('cabina-texto');
    const texto = campo.value.trim();
    if (!texto) { campo.focus(); return; }
    campo.disabled = true;
    cabinaRespuesta('Doof está en eso…');
    try {
      const d = await api('/cabina', { method: 'POST', body: JSON.stringify({ texto }) }, 50000);
      cabinaRespuesta(d.texto || '', !d.ok);
      if (d.ok) campo.value = '';
      cargar();
    } catch (err) {
      cabinaRespuesta('No le llegó a Doof: ' + err.message, true);
    }
    campo.disabled = false;
  });
  document.querySelector('.atajos').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cabina]');
    if (!b) return;
    const campo = $('cabina-texto');
    campo.value = b.dataset.cabina;
    campo.focus();
    campo.setSelectionRange(campo.value.length, campo.value.length);
  });

  $('b-play').addEventListener('click', () => (S.quiereSonar ? pausa() : play()));
  $('b-vivo').addEventListener('click', play);
  $('b-saltar').addEventListener('click', saltar);
  $('ahorro').checked = S.ahorro;
  $('ahorro').addEventListener('change', (e) => {
    S.ahorro = e.target.checked;
    guardar('doof_radio_ahorro', S.ahorro ? '1' : '0');
    if (S.quiereSonar) { S.reintentos = 0; conectar(); }
  });

  // ---------------------------------------------------------------- arranque
  function entrar(error) {
    $('entrar').hidden = false;
    $('radio').hidden = true;
    $('cabina').hidden = true;
    $('entrar-error').hidden = !error;
    $('entrar-error').textContent = error || '';
  }

  $('entrar-form').addEventListener('submit', (e) => {
    e.preventDefault();
    S.token = $('entrar-token').value.trim();
    guardar('doof_token', S.token);
    iniciar();
  });

  async function iniciar() {
    if (!S.token) { entrar(); return; }
    $('entrar').hidden = true;
    $('radio').hidden = false;
    $('cabina').hidden = false;
    pintarPlay();
    avisoRed('Buscando la PC…');
    let espera = 5;
    while (!(await encontrarPC())) {
      if (!$('entrar').hidden) return;
      avisoRed('La PC no responde (¿apagada?). Reintento en ' + espera + ' s…');
      await new Promise((r) => setTimeout(r, espera * 1000));
      espera = Math.min(espera * 2, 120);         // GitHub da 60 lecturas por hora sin autenticar
    }
    cargar();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  iniciar();
})();
