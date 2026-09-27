/* =====================================================================
   MOSTRADOR · Sistema de control para droguerías (Colombia)
   Versión conectada a Firebase (Authentication + Firestore)

   Organización de este archivo:
     1. Conexión a Firebase
     2. Utilidades (formatos, fechas)
     3. Sesión: iniciar, registrar droguería, elegir droguería
     4. Datos en vivo de la droguería (escuchas de Firestore)
     5. Reglas de negocio (semáforo, existencias, caja)
     6. Operaciones que escriben en la nube (ventas, compras, bajas, caja)
     7. Pantallas: inicio, vender, productos, inventario, compras,
        proveedores, caja, reportes, configuración, plataforma

   Modelo de datos en Firestore (ver LEEME.md):
     tenants/{droguería}                datos, configuración, estado
       members/{uid}                    personas y su rol
       productos, proveedores, lotes, compras, ventas, bajas, cajas
       contadores/ventas                consecutivo de comprobantes
       estado/caja                      cuál caja está abierta
   ===================================================================== */

import { firebaseConfig, soporte } from './firebase-config.js';
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, sendPasswordResetEmail } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, collectionGroup, query, where, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

/* =====================================================================
   1. CONEXIÓN
   ===================================================================== */
const configurado = firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith('PEGA');
let app, auth, db;
if (configurado) {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Caché local: la app abre rápido y consume menos lecturas del plan gratuito.
  db = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
}
const DIAS_PRUEBA = 30;
const VENTANA = 35; // días de ventas y cajas que se cargan en pantalla (cuidar lecturas del plan gratuito)

/* =====================================================================
   2. UTILIDADES
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
const fmt = n => COP.format(Math.round(n || 0));
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
const z2 = n => String(n).padStart(2, '0');
const isoDate = d => d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate());
const hoyISO = () => isoDate(new Date());
const ahora = () => { const d = new Date(); return isoDate(d) + 'T' + z2(d.getHours()) + ':' + z2(d.getMinutes()); };
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return isoDate(d); };
const addMonths = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setMonth(d.getMonth() + n); return isoDate(d); };
const diffDays = (a, b) => Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);
const fDate = iso => iso ? new Date(iso.slice(0, 10) + 'T12:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const fDT = iso => iso ? fDate(iso) + ' ' + iso.slice(11, 16) : '';
const fLarga = iso => { const s = new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); return s.charAt(0).toUpperCase() + s.slice(1); };
const num = s => { const v = String(s ?? '').trim(); if (!v) return 0; return Number(v.replace(/\s|\$/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')) || 0; };
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
const iniciales = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const docs = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

const ROLES = { admin: 'Administrador', regente: 'Regente de farmacia', vendedor: 'Vendedor' };
const MEDIOS = ['Efectivo', 'Tarjeta', 'Nequi', 'Daviplata', 'Transferencia', 'Crédito'];
const MOTIVOS = ['Vencido', 'Averiado', 'Devolución a proveedor', 'Faltante en conteo', 'Otro'];

function errMsg(e) {
  const c = e?.code || '';
  const m = {
    'auth/invalid-credential': 'Correo o contraseña incorrectos.',
    'auth/wrong-password': 'Correo o contraseña incorrectos.',
    'auth/user-not-found': 'Correo o contraseña incorrectos.',
    'auth/invalid-email': 'El correo no es válido.',
    'auth/email-already-in-use': 'Ese correo ya tiene una cuenta en Mostrador.',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos e intenta de nuevo.',
    'auth/network-request-failed': 'Sin conexión a internet.',
    'permission-denied': 'No tienes permiso para esta acción, o la droguería no está activa.',
    'unavailable': 'Sin conexión a internet. La operación no se registró; intenta de nuevo.',
    'failed-precondition': 'Sin conexión a internet. La operación no se registró; intenta de nuevo.',
    'aborted': 'Otro equipo modificó los mismos datos al tiempo. Intenta de nuevo.',
  };
  return m[c] || (c ? 'Error: ' + c : (e?.message || 'Ocurrió un error inesperado.'));
}

/* ---------- componentes de interfaz ---------- */
function toast(msg, kind) { const el = document.createElement('div'); el.className = 't ' + (kind || ''); el.textContent = msg; $('#toast').appendChild(el); setTimeout(() => el.remove(), kind === 'bad' ? 4500 : 2600); }
function modal(title, body, opt = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="mback"><div class="modal ${opt.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Cerrar">×</button></header><div class="mbody">${body}</div></div></div>`;
  $$('[data-close]', root).forEach(b => b.onclick = closeModal);
  $('.mback', root).addEventListener('mousedown', e => { if (e.target.classList.contains('mback')) closeModal(); });
  opt.onMount && opt.onMount(root);
  const f = root.querySelector('input:not([type=checkbox]),select,textarea'); if (f && !opt.noFocus) f.focus();
}
function closeModal() { $('#modal-root').innerHTML = ''; if (renderPendiente) programarRender(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal(); });
function confirmar(msg, okTxt, fn, danger = true) {
  modal('Confirmar', `<p>${msg}</p><div class="actions"><span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cf-ok">${esc(okTxt)}</button></div>`,
    { noFocus: true, onMount: r => { $('#cf-ok', r).onclick = () => { closeModal(); fn(); }; } });
}
const F = (label, inner, cls = '') => `<label class="f ${cls}"><span>${label}</span>${inner}</label>`;
const I = (id, v = '', a = '') => `<input class="in" id="${id}" value="${esc(v)}" ${a}>`;
const S = (id, opts, v) => `<select class="in" id="${id}">${opts.map(o => { const [k, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
const kpi = (l, v, s, cls = '') => `<div class="kpi ${cls}"><span class="k-l">${l}</span><span class="k-v">${v}</span><span class="k-s">${s}</span></div>`;
const tipoTag = t => t === 'libre' ? '' : `<span class="tipo ${t}">${t === 'control' ? 'Control' : 'Fórmula'}</span>`;
const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const CRUZ = `<svg class="cross" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7z"/></svg>`;
async function copiar(text, okMsg) { try { await navigator.clipboard.writeText(text); toast(okMsg || 'Copiado'); } catch (e) { toast('No se pudo copiar automáticamente', 'bad'); } }
// Deshabilita un botón mientras se guarda en la nube
async function ocupado(btn, fn) {
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.dataset.txt = btn.textContent; btn.textContent = 'Guardando…'; }
  try { return await fn(); }
  catch (e) { console.error(e); toast(errMsg(e), 'bad'); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btn.dataset.txt; } }
}
function pantalla(html) { $('#app').innerHTML = `<div class="login"><div class="login-card">${html}</div></div>`; }
function marca() { return `<div class="login-brand">${CRUZ.replace('class="cross"', '')}<b>Mostrador</b></div>`; }
function renderCargando(msg) { pantalla(`${marca()}<p class="muted">${esc(msg || 'Cargando…')}</p>`); }

/* =====================================================================
   3. SESIÓN
   ===================================================================== */
let fbUser = null, esSuper = false, membresias = [], registrando = null;

function renderLogin(modo = 'entrar') {
  const reg = modo === 'registro';
  pantalla(`${marca()}
    <div class="filters" role="tablist"><button data-m="entrar" aria-pressed="${!reg}">Iniciar sesión</button><button data-m="registro" aria-pressed="${reg}">Registrar mi droguería</button></div>
    ${reg ? `<p class="muted">Crea la cuenta de tu droguería. Tienes ${DIAS_PRUEBA} días de prueba. Tú quedas como administrador y luego agregas a tu equipo.</p>
      <form id="f-reg" class="form">
        ${F('Nombre de la droguería', I('r-nom', '', 'required autocomplete="organization"'))}
        <div class="form grid-f">${F('NIT', I('r-nit', '', 'placeholder="900.000.000-0"'))}${F('Ciudad o municipio', I('r-ciu'))}</div>
        ${F('Tu nombre', I('r-adm', '', 'required autocomplete="name"'))}
        ${F('Correo', I('r-mail', '', 'type="email" required autocomplete="email"'))}
        ${F('Contraseña (mínimo 6 caracteres)', I('r-pass', '', 'type="password" required minlength="6" autocomplete="new-password"'))}
        <button class="btn primary xl" id="r-go">Crear droguería</button>
      </form>`
    : `<form id="f-log" class="form">
        ${F('Correo', I('l-mail', lsGet('mostrador_mail') || '', 'type="email" required autocomplete="email"'))}
        ${F('Contraseña', I('l-pass', '', 'type="password" required autocomplete="current-password"'))}
        <button class="btn primary xl" id="l-go">Entrar</button>
        <button type="button" class="btn ghost" id="l-olv">Olvidé mi contraseña</button>
      </form>`}`);
  $$('[data-m]').forEach(b => b.onclick = () => renderLogin(b.dataset.m));
  if (reg) {
    $('#f-reg').onsubmit = e => { e.preventDefault(); ocupado($('#r-go'), async () => {
      registrando = { nombre: val('r-nom'), nit: val('r-nit'), ciudad: val('r-ciu'), admin: val('r-adm'), email: val('r-mail') };
      try { await createUserWithEmailAndPassword(auth, val('r-mail'), $('#r-pass').value); }
      catch (err) { registrando = null; throw err; }
    }); };
  } else {
    $('#f-log').onsubmit = e => { e.preventDefault(); ocupado($('#l-go'), async () => { lsSet('mostrador_mail', val('l-mail')); await signInWithEmailAndPassword(auth, val('l-mail'), $('#l-pass').value); }); };
    $('#l-olv').onclick = () => { const m = val('l-mail'); if (!m) return toast('Escribe tu correo primero', 'bad');
      sendPasswordResetEmail(auth, m).then(() => toast('Te enviamos un correo para cambiar la contraseña')).catch(e => toast(errMsg(e), 'bad')); };
  }
}

async function crearDrogueria(d) {
  const ref = doc(collection(db, 'tenants'));
  const b = writeBatch(db);
  b.set(ref, { ownerUid: fbUser.uid, estado: 'prueba', creado: serverTimestamp(),
    info: { nombre: d.nombre, nit: d.nit || '', ciudad: d.ciudad || '', direccion: '', telefono: '', responsable: '' },
    config: { rojoMeses: 6, amarilloMeses: 12, prefijo: 'V' } });
  b.set(doc(ref, 'members', fbUser.uid), { uid: fbUser.uid, nombre: d.admin, email: fbUser.email || d.email || '', rol: 'admin', activo: true, doc: '' });
  b.set(doc(ref, 'contadores', 'ventas'), { n: 0 });
  b.set(doc(ref, 'estado', 'caja'), { abiertaId: null });
  await b.commit();
  return ref.id;
}

async function cargarMembresias() {
  const [sup, ms] = await Promise.all([
    getDoc(doc(db, 'superadmins', fbUser.uid)).then(s => s.exists()).catch(() => false),
    getDocs(query(collectionGroup(db, 'members'), where('uid', '==', fbUser.uid))),
  ]);
  esSuper = sup;
  membresias = ms.docs.map(d => ({ tenantId: d.ref.parent.parent.id, ...d.data() })).filter(m => m.activo);
  await Promise.all(membresias.map(async m => {
    try { const t = (await getDoc(doc(db, 'tenants', m.tenantId))).data() || {}; m.nombre = t.info?.nombre || 'Droguería'; m.estado = t.estado; } catch (e) { m.nombre = 'Droguería'; }
  }));
}

if (configurado) onAuthStateChanged(auth, async user => {
  salirDrogueria();
  fbUser = user;
  if (!user) { esSuper = false; membresias = []; return renderLogin(); }
  renderCargando('Cargando tu cuenta…');
  try {
    if (registrando) { const d = registrando; registrando = null; const id = await crearDrogueria(d); lsSet('mostrador_ultima', id); }
    await cargarMembresias();
    const ultima = lsGet('mostrador_ultima');
    if (ultima && membresias.some(m => m.tenantId === ultima)) return entrarDrogueria(ultima);
    if (membresias.length === 1 && !esSuper) return entrarDrogueria(membresias[0].tenantId);
    renderSelector();
  } catch (e) { console.error(e); renderFallo(e); }
});

function renderSelector() {
  pantalla(`${marca()}
    <p class="muted">Sesión iniciada como <b>${esc(fbUser.email)}</b></p>
    ${membresias.length ? `<div class="f"><span>Elige la droguería</span><div class="users">${membresias.map(m => `<button type="button" data-t="${m.tenantId}"><span class="avatar">${esc(iniciales(m.nombre))}</span><div><strong>${esc(m.nombre)}</strong><span>${ROLES[m.rol] || m.rol}</span></div></button>`).join('')}</div></div>`
      : `<div class="hint-box">Tu usuario todavía no pertenece a ninguna droguería. Pide al administrador de tu droguería que te agregue, o registra una droguería nueva.</div>`}
    <div class="actions">${esSuper ? '<button class="btn" id="s-plat">Panel de plataforma</button>' : ''}<button class="btn" id="s-new">Registrar otra droguería</button><span class="grow"></span><button class="btn ghost" id="s-out">Salir</button></div>`);
  $$('[data-t]').forEach(b => b.onclick = () => entrarDrogueria(b.dataset.t));
  $('#s-out').onclick = () => signOut(auth);
  $('#s-new').onclick = () => modalNuevaDrogueria();
  if (esSuper) $('#s-plat').onclick = renderPlataforma;
}
function modalNuevaDrogueria() {
  modal('Registrar droguería', `<form id="fnd" class="form grid-f">
    ${F('Nombre de la droguería', I('nd-n', '', 'required'), 'span2')}${F('NIT', I('nd-nit'))}${F('Ciudad', I('nd-c'))}
    ${F('Tu nombre como administrador', I('nd-a', membresias[0]?.nombre ? '' : '', 'required'), 'span2')}
    <div class="actions span-all"><span class="grow"></span><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" id="nd-go">Crear droguería</button></div></form>`,
  { onMount: r => $('#fnd', r).onsubmit = e => { e.preventDefault(); ocupado($('#nd-go'), async () => {
    if (!val('nd-n') || !val('nd-a')) return toast('Completa el nombre de la droguería y tu nombre', 'bad');
    const id = await crearDrogueria({ nombre: val('nd-n'), nit: val('nd-nit'), ciudad: val('nd-c'), admin: val('nd-a') });
    closeModal(); await cargarMembresias(); entrarDrogueria(id); toast('Droguería creada');
  }); } });
}
function renderFallo(e) {
  pantalla(`${marca()}<div class="banner bad"><div><strong>No se pudo cargar la información.</strong><br>${esc(errMsg(e))}</div></div>
    <div class="actions"><button class="btn primary" id="f-re">Reintentar</button><button class="btn ghost" id="f-out">Salir</button></div>`);
  $('#f-re').onclick = () => location.reload();
  $('#f-out').onclick = () => signOut(auth);
}
function renderSinConfigurar() {
  pantalla(`${marca()}<div class="banner warn"><div><strong>Falta conectar Firebase.</strong><br>Abre el archivo <span class="mono">firebase-config.js</span> y pega la configuración de tu proyecto de Firebase. Los pasos están en <span class="mono">LEEME.md</span>.</div></div>`);
}

/* =====================================================================
   4. DATOS EN VIVO DE LA DROGUERÍA
   Cada colección se escucha con onSnapshot. Cuando otro equipo vende o
   recibe mercancía, la pantalla se actualiza sola.
   ===================================================================== */
let TID = null, C = null, escuchas = [], escuchasDatos = [], escuchaCaja = null;
const T = () => C;
const U = () => C?.usuarios.find(u => u.id === fbUser?.uid);
const prod = id => C.productos.find(p => p.id === id);
const prov = id => C.proveedores.find(p => p.id === id);
const tcol = n => collection(db, 'tenants', TID, n);
const tdoc = (n, id) => doc(db, 'tenants', TID, n, id);

function salirDrogueria() {
  [...escuchas, ...escuchasDatos].forEach(u => u()); escuchas = []; escuchasDatos = [];
  if (escuchaCaja) { escuchaCaja(); escuchaCaja = null; }
  TID = null; C = null; cart = [];
}
function operativa() {
  if (C.estado === 'activa') return true;
  return C.estado === 'prueba' && Date.now() < C.creado + DIAS_PRUEBA * 86400000;
}
const diasPrueba = () => Math.max(0, Math.ceil((C.creado + DIAS_PRUEBA * 86400000 - Date.now()) / 86400000));

function entrarDrogueria(id) {
  salirDrogueria();
  TID = id; lsSet('mostrador_ultima', id);
  C = { id, info: {}, config: { rojoMeses: 6, amarilloMeses: 12, prefijo: 'V' }, estado: 'prueba', creado: Date.now(),
    usuarios: [], productos: [], proveedores: [], lotes: [], compras: [], ventas: [], bajas: [], cajas: [],
    seq: { venta: 0 }, cajaAbiertaId: null, cajaAbierta: null, listo: false, datosIniciados: false };
  renderCargando('Abriendo la droguería…');
  escuchas.push(onSnapshot(doc(db, 'tenants', id), s => {
    const d = s.data({ serverTimestamps: 'estimate' });
    if (!d) return renderFallo({ message: 'La droguería no existe o no tienes acceso.' });
    Object.assign(C, { info: d.info || {}, config: d.config, estado: d.estado, ownerUid: d.ownerUid, creado: d.creado ? d.creado.toMillis() : Date.now() });
    if (!operativa()) { escuchasDatos.forEach(u => u()); escuchasDatos = []; C.datosIniciados = false; return renderBloqueada(); }
    if (!C.datosIniciados) iniciarDatos(); else programarRender();
  }, e => renderFallo(e)));
}

function iniciarDatos() {
  C.datosIniciados = true; C.listo = false;
  const hoy = hoyISO();
  const fuentes = [
    ['usuarios', collection(db, 'tenants', TID, 'members')],
    ['productos', tcol('productos')],
    ['proveedores', tcol('proveedores')],
    ['lotes', query(tcol('lotes'), where('cant', '>', 0))],
    ['compras', query(tcol('compras'), where('fecha', '>=', addDays(hoy, -365)))],
    ['ventas', query(tcol('ventas'), where('dia', '>=', addDays(hoy, -VENTANA)))],
    ['bajas', query(tcol('bajas'), where('dia', '>=', addDays(hoy, -365)))],
    ['cajas', query(tcol('cajas'), where('dia', '>=', addDays(hoy, -VENTANA)))],
  ];
  let faltan = fuentes.length + 2;
  const listo = () => { if (--faltan === 0) { C.listo = true; primeraPantalla(); } };
  const fallo = e => { console.error(e); if (e.code === 'permission-denied') renderFallo(e); else toast(errMsg(e), 'bad'); };
  fuentes.forEach(([k, q]) => {
    let primera = true;
    escuchasDatos.push(onSnapshot(q, snap => { C[k] = docs(snap); if (primera) { primera = false; listo(); } else programarRender(); }, fallo));
  });
  let p1 = true;
  escuchasDatos.push(onSnapshot(tdoc('contadores', 'ventas'), s => { C.seq.venta = s.data()?.n || 0; if (p1) { p1 = false; listo(); } }, fallo));
  let p2 = true;
  escuchasDatos.push(onSnapshot(tdoc('estado', 'caja'), s => {
    const cid = s.data()?.abiertaId || null;
    if (cid !== C.cajaAbiertaId) {
      C.cajaAbiertaId = cid; C.cajaAbierta = null;
      if (escuchaCaja) { escuchaCaja(); escuchaCaja = null; }
      if (cid) escuchaCaja = onSnapshot(tdoc('cajas', cid), cs => { C.cajaAbierta = cs.exists() ? { id: cs.id, ...cs.data() } : null; if (C.listo) programarRender(); }, fallo);
    }
    if (p2) { p2 = false; listo(); } else programarRender();
  }, fallo));
}
function primeraPantalla() {
  const u = U();
  if (!u || u.activo === false) { toast('Tu usuario está inactivo en esta droguería', 'bad'); lsSet('mostrador_ultima', ''); return signOut(auth); }
  const h = (location.hash || '').slice(1);
  route = VISTAS.some(v => v[0] === h) && puedeVer(h) ? h : 'inicio';
  renderShell();
}
function renderBloqueada() {
  const susp = C.estado === 'suspendida';
  pantalla(`${marca()}<h2>${esc(C.info.nombre || 'Droguería')}</h2>
    <div class="banner ${susp ? 'bad' : 'warn'}"><div><strong>${susp ? 'La cuenta de esta droguería está suspendida.' : `Terminó el periodo de prueba de ${DIAS_PRUEBA} días.`}</strong><br>
    Para seguir usando Mostrador comunícate con soporte. Tu información está guardada y no se ha borrado.</div></div>
    <div class="hint-box">${esc(soporte?.nombre || 'Soporte')}${soporte?.telefono ? ' · ' + esc(soporte.telefono) : ''}${soporte?.correo ? ' · ' + esc(soporte.correo) : ''}</div>
    <div class="actions">${membresias.length > 1 || esSuper ? '<button class="btn" id="b-sel">Cambiar de droguería</button>' : ''}<span class="grow"></span><button class="btn ghost" id="b-out">Salir</button></div>`);
  $('#b-out').onclick = () => signOut(auth);
  const s = $('#b-sel'); if (s) s.onclick = () => { salirDrogueria(); lsSet('mostrador_ultima', ''); renderSelector(); };
}

/* Redibujar cuando llegan cambios de otros equipos, sin interrumpir
   a quien está escribiendo en un formulario. */
let renderPendiente = false, renderTimer = null;
function ocupadoEscribiendo() {
  if ($('#modal-root').innerHTML) return true;
  const a = document.activeElement;
  return !!a && a.id !== 'pos-q' && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName);
}
function programarRender() {
  if (!C || !C.listo || !main) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if (!C || !C.listo) return;
    if (ocupadoEscribiendo()) { renderPendiente = true; return; }
    renderPendiente = false; renderShell(true);
  }, 150);
}
document.addEventListener('focusout', () => setTimeout(() => { if (renderPendiente && !ocupadoEscribiendo()) programarRender(); }, 250));

/* =====================================================================
   5. REGLAS DE NEGOCIO
   ===================================================================== */
function nombreProd(p) { return [p.nombre, p.concentracion && p.concentracion !== '—' ? p.concentracion : '', p.forma].filter(Boolean).join(' · '); }
function semaforo(vence) {
  const c = C.config, hoy = hoyISO();
  if (vence < hoy) return { k: 'venc', t: 'Vencido' };
  if (vence <= addMonths(hoy, c.rojoMeses)) return { k: 'rojo', t: 'Rojo' };
  if (vence <= addMonths(hoy, c.amarilloMeses)) return { k: 'amar', t: 'Amarillo' };
  return { k: 'verde', t: 'Verde' };
}
const semChip = v => { const s = semaforo(v); return `<span class="sem ${s.k}">${s.t}</span>`; };
const ordenFEFO = (a, b) => a.vence.localeCompare(b.vence) || String(a.ingreso).localeCompare(String(b.ingreso));
function disponible(pid) { const d = hoyISO(); return sum(C.lotes.filter(l => l.pid === pid && l.cant > 0 && l.vence >= d), l => l.cant); }
function loteProximo(pid) { return C.lotes.filter(l => l.pid === pid && l.cant > 0).sort(ordenFEFO)[0]; }
function fmtStock(p, u) {
  const upc = p?.upc || 1;
  if (upc > 1) { const c = Math.floor(u / upc), r = u % upc; return ((c ? c + ' cj' : '') + (c && r ? ' + ' : '') + (r ? r + ' und' : '')) || '0'; }
  return u + ' und';
}
function alertas() {
  const hoy = hoyISO();
  const venc = C.lotes.filter(l => l.cant > 0 && l.vence < hoy);
  const rojo = C.lotes.filter(l => l.cant > 0 && l.vence >= hoy && semaforo(l.vence).k === 'rojo');
  const bajo = C.productos.filter(p => disponible(p.id) < (p.stockMin || 0) * (p.upc || 1));
  return { venc, rojo, bajo };
}
const ventasValidas = () => C.ventas.filter(v => !v.anulada);
const cajaAbierta = () => C.cajaAbiertaId ? (C.cajaAbierta || C.cajas.find(c => c.id === C.cajaAbiertaId) || null) : null;
function esperadoCaja(c) {
  const vs = C.ventas.filter(v => v.cajaId === c.id && !v.anulada), por = {};
  vs.forEach(v => v.pagos.forEach(p => por[p.medio] = (por[p.medio] || 0) + p.valor));
  return { por, efectivo: c.base + (por['Efectivo'] || 0), total: sum(vs, v => v.total), n: vs.length };
}

/* ---------- permisos (la nube los vuelve a verificar con las reglas) ---------- */
const VISTAS = [
  ['inicio', 'Inicio', 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', ['admin', 'regente', 'vendedor']],
  ['vender', 'Vender', 'M3 4h2l2.4 11h11l2-8H6.2M9 20.5h.01M18 20.5h.01', ['admin', 'regente', 'vendedor']],
  ['productos', 'Productos', 'M10.5 20.5a4.95 4.95 0 0 1-7-7l10-10a4.95 4.95 0 0 1 7 7zM8.5 8.5l7 7', ['admin', 'regente', 'vendedor']],
  ['inventario', 'Inventario y lotes', 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10', ['admin', 'regente', 'vendedor']],
  ['compras', 'Compras', 'M5 3h10l4 4v14H5zM9 11h6M9 15h6M9 7h3', ['admin', 'regente']],
  ['proveedores', 'Proveedores', 'M2 17V6h11v11M13 10h4l4 4v3h-8M6.5 19.5h.01M17.5 19.5h.01', ['admin', 'regente']],
  ['caja', 'Caja', 'M3 7h18v12H3zM3 11h18M7 15h4', ['admin', 'regente', 'vendedor']],
  ['reportes', 'Reportes', 'M4 20V11M10 20V4M16 20v-7M21 20H3', ['admin', 'regente']],
  ['config', 'Configuración', 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4', ['admin']],
];
const puedeVer = r => { const v = VISTAS.find(x => x[0] === r); return v && U() && v[3].includes(U().rol); };
const PERM = { editarProducto: ['admin', 'regente'], baja: ['admin', 'regente'], anular: ['admin', 'regente'], control: ['admin', 'regente'] };
const can = a => !!U() && PERM[a].includes(U().rol);

/* =====================================================================
   6. OPERACIONES EN LA NUBE
   Todo lo que mueve inventario o dinero se hace en una transacción:
   si dos equipos venden el mismo lote al tiempo, Firestore reintenta
   con los datos frescos y nunca deja existencias negativas.
   ===================================================================== */
async function registrarVenta(o) {
  const ventaRef = doc(tcol('ventas'));
  const dia = o.fecha.slice(0, 10);
  return runTransaction(db, async tx => {
    const cntRef = tdoc('contadores', 'ventas');
    const cnt = await tx.get(cntRef);
    const caja = await tx.get(tdoc('cajas', o.cajaId));
    if (!caja.exists() || caja.data().cierre) throw new Error('La caja se cerró desde otro equipo. Ábrela de nuevo para vender.');
    // Lectura fresca de los lotes candidatos
    const frescos = {};
    for (const pid of new Set(o.items.map(i => i.pid))) {
      for (const l of C.lotes.filter(x => x.pid === pid && x.vence >= dia)) {
        const s = await tx.get(tdoc('lotes', l.id));
        if (s.exists()) frescos[l.id] = { id: l.id, ...s.data() };
      }
    }
    const items = o.items.map(it => {
      const p = prod(it.pid), esCaja = it.modo === 'caja';
      const units = it.cant * (esCaja ? (p.upc || 1) : 1);
      const precio = esCaja ? p.precioCaja : p.precioUnidad;
      let r = units; const lotes = [];
      for (const l of Object.values(frescos).filter(x => x.pid === p.id && x.cant > 0 && x.vence >= dia).sort(ordenFEFO)) {
        if (r <= 0) break; const k = Math.min(l.cant, r); l.cant -= k; r -= k;
        lotes.push({ loteId: l.id, lote: l.lote, vence: l.vence, cant: k, costoU: l.costoU });
      }
      if (r > 0) throw new Error(`Ya no hay existencias suficientes de ${p.nombre}. Pudieron venderse desde otro equipo.`);
      const total = precio * it.cant, base = total / (1 + (p.iva || 0) / 100);
      return { pid: p.id, nombre: nombreProd(p), tipo: p.tipo, modo: it.modo, upc: p.upc || 1, cant: it.cant, units, precio, iva: p.iva || 0, total, base, costo: sum(lotes, l => l.cant * l.costoU), lotes };
    });
    const n = (cnt.data()?.n || 0) + 1;
    const total = sum(items, i => i.total), base = sum(items, i => i.base);
    const recibe = o.medio === 'Efectivo' && o.recibe ? o.recibe : total;
    const venta = { consecutivo: n, numero: (C.config.prefijo || 'V') + '-' + String(n).padStart(6, '0'), fecha: o.fecha, dia, creado: serverTimestamp(),
      userId: fbUser.uid, usuario: U().nombre, cajaId: o.cajaId, items, total, base, iva: total - base, costo: sum(items, i => i.costo),
      pagos: [{ medio: o.medio, valor: total }], recibe, cambio: Math.max(0, recibe - total), formula: o.formula || null, anulada: false };
    tx.set(ventaRef, venta);
    tx.update(cntRef, { n });
    new Set(items.flatMap(i => i.lotes.map(l => l.loteId))).forEach(id => tx.update(tdoc('lotes', id), { cant: frescos[id].cant, ultimoMov: ventaRef.id }));
    return { id: ventaRef.id, ...venta, creado: null };
  });
}
async function anularVenta(v, motivo) {
  await runTransaction(db, async tx => {
    const vr = tdoc('ventas', v.id), s = await tx.get(vr);
    if (!s.exists() || s.data().anulada) throw new Error('Esta venta ya estaba anulada.');
    const suma = {}; s.data().items.forEach(it => it.lotes.forEach(u => suma[u.loteId] = (suma[u.loteId] || 0) + u.cant));
    const snaps = {}; for (const id of Object.keys(suma)) snaps[id] = await tx.get(tdoc('lotes', id));
    for (const id of Object.keys(suma)) if (snaps[id].exists()) tx.update(tdoc('lotes', id), { cant: snaps[id].data().cant + suma[id], ultimoMov: 'anula-' + v.id });
    tx.update(vr, { anulada: { fecha: ahora(), userId: fbUser.uid, usuario: U().nombre, motivo } });
  });
}
async function abrirCaja(base) {
  const ref = doc(tcol('cajas'));
  await runTransaction(db, async tx => {
    const est = await tx.get(tdoc('estado', 'caja'));
    if (est.data()?.abiertaId) throw new Error('Ya hay una caja abierta en esta droguería.');
    tx.set(ref, { apertura: ahora(), dia: hoyISO(), base: Math.max(0, Math.round(base || 0)), userId: fbUser.uid, usuario: U().nombre, cierre: null });
    tx.update(tdoc('estado', 'caja'), { abiertaId: ref.id });
  });
  toast('Caja abierta con base de ' + fmt(base));
}
async function cerrarCaja(c, contado, obs) {
  const e = esperadoCaja(c);
  await runTransaction(db, async tx => {
    const s = await tx.get(tdoc('cajas', c.id));
    if (!s.exists() || s.data().cierre) throw new Error('Esta caja ya fue cerrada.');
    tx.update(tdoc('cajas', c.id), { cierre: { fecha: ahora(), contado, esperado: e.efectivo, dif: Math.round(contado - e.efectivo), total: e.total, por: e.por, obs, userId: fbUser.uid, usuario: U().nombre } });
    tx.update(tdoc('estado', 'caja'), { abiertaId: null });
  });
}

/* =====================================================================
   7. PANTALLAS
   ===================================================================== */
let route = 'inicio', main = null;
const uiState = { invFiltro: 'todos', invQ: '', prodQ: '', prodTipo: '', repDesde: null, repHasta: null, repRango: '7' };
function go(r, extra) {
  if (!puedeVer(r)) { toast('Tu rol no tiene acceso a esa sección', 'bad'); r = 'inicio'; }
  route = r; if (extra) Object.assign(uiState, extra);
  try { history.replaceState(null, '', '#' + r); } catch (e) {}
  renderShell(); window.scrollTo(0, 0);
}
function renderShell(conservarScroll) {
  if (!C || !C.listo) return;
  const u = U();
  if (!u || u.activo === false) { toast('Tu usuario fue desactivado en esta droguería', 'bad'); return signOut(auth); }
  if (!puedeVer(route)) route = 'inicio';
  const y = window.scrollY, al = alertas(), nAl = al.venc.length;
  const prueba = C.estado === 'prueba';
  $('#app').innerHTML = `<div class="shell">
    <aside class="side">
      <div class="side-top">
        <div class="brand">${CRUZ}<b>Mostrador</b></div>
        <div class="tenant"><strong>${esc(C.info.nombre)}</strong><span>${C.info.nit ? 'NIT ' + esc(C.info.nit) + ' · ' : ''}${esc(C.info.ciudad || '')}</span>
          ${prueba ? `<span class="pill warn" style="margin-top:6px">Prueba: ${diasPrueba()} días</span>` : ''}
          ${membresias.length > 1 || esSuper ? '<button class="btn ghost sm" id="cambiar" style="margin-top:4px;padding-inline:0">Cambiar de droguería</button>' : ''}</div>
        <div class="me-mini"><span class="avatar" title="${esc(u.nombre)}">${esc(iniciales(u.nombre))}</span><button class="btn ghost sm" id="salir2">Salir</button></div>
      </div>
      <nav class="nav" aria-label="Secciones">${VISTAS.filter(v => v[3].includes(u.rol)).map(v => `<button data-go="${v[0]}" ${route === v[0] ? 'aria-current="page"' : ''}>${icon(v[2])}<span>${v[1]}</span>${v[0] === 'inventario' && nAl ? `<span class="badge" title="Lotes vencidos con existencias">${nAl}</span>` : ''}</button>`).join('')}</nav>
      <div class="me"><span class="avatar">${esc(iniciales(u.nombre))}</span><div><strong>${esc(u.nombre)}</strong><span>${ROLES[u.rol]}</span></div><button class="btn ghost sm" id="salir">Salir</button></div>
    </aside>
    <main id="main"></main>
  </div>`;
  main = $('#main');
  const salir = () => { lsSet('mostrador_ultima', ''); signOut(auth); };
  $('#salir').onclick = salir; $('#salir2').onclick = salir;
  const cb = $('#cambiar'); if (cb) cb.onclick = () => { salirDrogueria(); lsSet('mostrador_ultima', ''); renderSelector(); };
  ({ inicio: vInicio, vender: vVender, productos: vProductos, inventario: vInventario, compras: vCompras, proveedores: vProveedores, caja: vCaja, reportes: vReportes, config: vConfig })[route]();
  if (conservarScroll) window.scrollTo(0, y);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-go]'); if (!b || !C) return;
  go(b.dataset.go, b.dataset.filtro ? { invFiltro: b.dataset.filtro } : null);
});

/* ---------- INICIO ---------- */
function vInicio() {
  const hoy = hoyISO(), vs = ventasValidas();
  const vh = vs.filter(v => v.dia === hoy), tot = sum(vh, v => v.total);
  const ayer = sum(vs.filter(v => v.dia === addDays(hoy, -1)), v => v.total);
  const caja = cajaAbierta(), al = alertas();
  const items = [];
  if (!caja) items.push(['var(--warn)', 'La caja está cerrada', 'Ábrela con la base de efectivo antes de vender.', 'caja', '', 'Abrir caja']);
  if (!C.productos.length) items.push(['var(--accent)', 'Tu catálogo está vacío', 'Crea productos, impórtalos desde Excel o carga el catálogo de ejemplo.', 'productos', '', 'Ir a productos']);
  if (al.venc.length) items.push(['var(--dead-bg)', `${al.venc.length} lote${al.venc.length > 1 ? 's' : ''} vencido${al.venc.length > 1 ? 's' : ''} con existencias`, 'Sepáralos del área de venta y regístralos como baja.', 'inventario', 'venc', 'Revisar']);
  if (al.rojo.length) items.push(['var(--bad)', `${al.rojo.length} lote${al.rojo.length > 1 ? 's' : ''} en semáforo rojo`, `Vencen en menos de ${C.config.rojoMeses} meses. Priorízalos o gestiona devolución.`, 'inventario', 'rojo', 'Ver lotes']);
  if (al.bajo.length) items.push(['var(--warn)', `${al.bajo.length} producto${al.bajo.length > 1 ? 's' : ''} bajo el stock mínimo`, al.bajo.slice(0, 3).map(p => p.nombre).join(', ') + (al.bajo.length > 3 ? '…' : ''), 'inventario', 'bajo', 'Ver']);
  const proximos = C.lotes.filter(l => l.cant > 0 && ['venc', 'rojo'].includes(semaforo(l.vence).k)).sort(ordenFEFO).slice(0, 6);
  const ult = [...vs].sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 6);
  main.innerHTML = `
  <header class="ph"><div><p class="eyebrow">${fLarga(hoy)}</p><h1>Hola, ${esc(U().nombre.split(' ')[0])}</h1></div>
    <div class="ph-act"><button class="btn primary" data-go="vender">Nueva venta</button></div></header>
  <section class="kpis">
    ${kpi('Ventas de hoy', fmt(tot), `${vh.length} venta${vh.length === 1 ? '' : 's'} · ayer ${fmt(ayer)}`)}
    ${kpi('Ticket promedio', vh.length ? fmt(tot / vh.length) : '—', 'Valor promedio por venta hoy')}
    ${kpi('Caja', caja ? 'Abierta' : 'Cerrada', caja ? `Efectivo esperado ${fmt(esperadoCaja(caja).efectivo)}` : 'Sin caja abierta', caja ? 'ok' : 'warn')}
    ${kpi('Productos', C.productos.length, `${al.bajo.length} bajo el mínimo · ${C.lotes.length} lotes activos`)}
  </section>
  <div class="grid2">
    <section class="card"><h2>Requiere atención</h2>
      ${items.length ? `<ul class="alist">${items.map(i => `<li><span class="dot" style="background:${i[0]}"></span><div class="txt"><strong>${i[1]}</strong><span>${esc(i[2])}</span></div><button class="btn sm" data-go="${i[3]}" ${i[4] ? `data-filtro="${i[4]}"` : ''}>${i[5]}</button></li>`).join('')}</ul>` : '<p class="muted">Todo en orden. No hay vencidos, lotes en rojo ni productos bajo el mínimo.</p>'}
    </section>
    <section class="card flush"><div class="card-h"><h2>Últimas ventas</h2>${puedeVer('reportes') ? '<button class="btn ghost sm" data-go="reportes">Ver todas</button>' : ''}</div>
      <div class="tbl"><table><thead><tr><th>Venta</th><th>Hora</th><th>Medio</th><th class="n">Total</th></tr></thead><tbody>
      ${ult.map(v => `<tr><td><button class="btn ghost sm mono" data-tir="${v.id}">${v.numero}</button></td><td class="muted">${fDT(v.fecha)}</td><td>${v.pagos[0].medio}</td><td class="n"><b>${fmt(v.total)}</b></td></tr>`).join('') || '<tr><td colspan="4" class="empty">Aún no hay ventas.</td></tr>'}
      </tbody></table></div></section>
  </div>
  <section class="card flush"><div class="card-h"><h2>Próximos a vencer</h2><button class="btn ghost sm" data-go="inventario" data-filtro="rojo">Inventario</button></div>
    <div class="tbl"><table><thead><tr><th>Producto</th><th>Lote</th><th>Vence</th><th>Semáforo</th><th class="n">Existencia</th></tr></thead><tbody>
    ${proximos.map(l => { const p = prod(l.pid) || { nombre: '(producto eliminado)', concentracion: '' }; const d = diffDays(l.vence, hoy); return `<tr><td><b>${esc(p.nombre)}</b> <span class="muted">${esc(p.concentracion)}</span></td><td class="mono">${esc(l.lote)}</td><td>${fDate(l.vence)}<span class="sub">${d < 0 ? `hace ${-d} días` : `en ${d} días`}</span></td><td>${semChip(l.vence)}</td><td class="n">${fmtStock(p, l.cant)}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">No hay lotes vencidos ni en rojo.</td></tr>'}
    </tbody></table></div></section>`;
  $$('[data-tir]', main).forEach(b => b.onclick = () => verTirilla(C.ventas.find(v => v.id === b.dataset.tir)));
}

/* ---------- PUNTO DE VENTA ---------- */
let cart = [];
let pos = { medio: 'Efectivo', recibe: '', q: '', rx: { medico: '', registro: '', paciente: '', doc: '' } };
let cobrando = false;
function unidadesEnCarrito(pid, excepto) { return sum(cart.filter(c => c.pid === pid && c !== excepto), c => c.cant * (c.modo === 'caja' ? (prod(c.pid)?.upc || 1) : 1)); }
function vVender() {
  cart = cart.filter(c => prod(c.pid)); // por si borraron un producto desde otro equipo
  const caja = cajaAbierta();
  main.innerHTML = `
  <header class="ph"><div><p class="eyebrow">Punto de venta</p><h1>Vender</h1></div>
    <div class="ph-act">${caja ? `<span class="pill ok">Caja abierta desde ${String(caja.apertura).slice(11, 16)} · ${esc(caja.usuario)}</span>` : ''}</div></header>
  ${caja ? '' : `<div class="banner warn"><div><strong>La caja está cerrada.</strong> Ábrela con la base de efectivo para registrar ventas.</div>
    <div class="inline"><label class="sr" for="ab-base">Base de efectivo</label><input id="ab-base" class="in" type="number" min="0" step="1000" value="150000"><button class="btn primary" id="ab-go">Abrir caja</button></div></div>`}
  <div class="pos">
    <div class="pos-left">
      <label class="sr" for="pos-q">Buscar producto</label>
      <input id="pos-q" class="in lg" placeholder="Escanea el código de barras o escribe nombre, principio activo o laboratorio" autocomplete="off" value="${esc(pos.q)}">
      <div id="pos-res" class="results"></div>
      <section class="card flush"><div class="card-h"><h2>Venta actual</h2><button class="btn ghost sm" id="pos-clear">Vaciar</button></div><div id="pos-cart"></div></section>
    </div>
    <aside class="pos-right card" id="pos-sum"></aside>
  </div>`;
  if (!caja) $('#ab-go').onclick = e => ocupado(e.currentTarget, () => abrirCaja(num(val('ab-base'))));
  const q = $('#pos-q');
  q.oninput = () => { pos.q = q.value; posResults(); };
  q.onkeydown = e => {
    if (e.key !== 'Enter') return;
    const s = q.value.trim(); if (!s) return;
    const exact = C.productos.find(p => p.codigo && p.codigo === s);
    const list = buscar(s);
    const p = exact || (list.length === 1 ? list[0] : null);
    if (p) { addCart(p.id, 'caja'); q.value = ''; pos.q = ''; posResults(); }
  };
  $('#pos-clear').onclick = () => { cart = []; posCart(); posSum(); };
  posResults(); posCart(); posSum(); q.focus();
}
function buscar(s) {
  const n = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const w = n(s).split(/\s+/).filter(Boolean);
  return C.productos.filter(p => { const h = n([p.codigo, p.nombre, p.principio, p.lab, p.concentracion, p.forma].join(' ')); return w.every(x => h.includes(x)); });
}
function posResults() {
  const box = $('#pos-res'), s = pos.q.trim();
  let list, hint;
  if (s) { list = buscar(s).slice(0, 8); hint = list.length ? `${list.length} resultado${list.length > 1 ? 's' : ''}` : 'Sin resultados'; }
  else {
    const cnt = {}; ventasValidas().slice(-200).forEach(v => v.items.forEach(i => cnt[i.pid] = (cnt[i.pid] || 0) + 1));
    list = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).map(prod).filter(Boolean).slice(0, 5);
    hint = list.length ? 'Más vendidos' : 'Escribe para buscar';
  }
  box.innerHTML = `<div class="hint">${hint}</div>` + list.map(p => {
    const d = disponible(p.id);
    return `<div class="res"><div><strong>${esc(p.nombre)} ${esc(p.concentracion !== '—' ? p.concentracion : '')}</strong>${tipoTag(p.tipo)}<span class="sub">${esc(p.forma)} · ${esc(p.principio)} · ${esc(p.lab)} · <span class="mono">${esc(p.codigo)}</span></span></div>
      <div class="res-stock ${d ? '' : 'muted'}">${d ? fmtStock(p, d) : 'Agotado'}<span class="sub">${esc(p.ubicacion || '')}</span></div>
      <div class="res-price"><strong>${fmt(p.precioCaja)}</strong>${p.fracc ? `<span class="sub">${fmt(p.precioUnidad)} und</span>` : `<span class="sub">${p.upc > 1 ? 'x' + p.upc : 'unidad'}</span>`}</div>
      <div class="res-btns"><button class="btn sm" data-add="${p.id}" data-modo="caja" ${d ? '' : 'disabled'}>+ ${p.upc > 1 ? 'Caja' : 'Agregar'}</button>${p.fracc ? `<button class="btn sm" data-add="${p.id}" data-modo="unidad" ${d ? '' : 'disabled'}>+ Und</button>` : ''}</div></div>`;
  }).join('');
  $$('[data-add]', box).forEach(b => b.onclick = () => { addCart(b.dataset.add, b.dataset.modo); $('#pos-q').focus(); });
}
function addCart(pid, modo) {
  const p = prod(pid); if (!p) return;
  if (!p.fracc) modo = 'caja';
  const need = modo === 'caja' ? (p.upc || 1) : 1;
  if (unidadesEnCarrito(pid) + need > disponible(pid)) return toast(`Sin existencias suficientes de ${p.nombre} (disponible ${fmtStock(p, disponible(pid))})`, 'bad');
  const ex = cart.find(c => c.pid === pid && c.modo === modo);
  if (ex) ex.cant++; else cart.push({ pid, modo, cant: 1 });
  posCart(); posSum();
}
function posCart() {
  const box = $('#pos-cart');
  if (!cart.length) { box.innerHTML = '<p class="empty">Escanea o busca un producto para empezar.</p>'; return; }
  box.innerHTML = `<div class="tbl"><table><thead><tr><th>Producto</th><th>Presentación</th><th>Cant.</th><th class="n">Precio</th><th class="n">Subtotal</th><th></th></tr></thead><tbody>
  ${cart.map((c, i) => { const p = prod(c.pid); const pr = c.modo === 'caja' ? p.precioCaja : p.precioUnidad; return `<tr>
    <td><b>${esc(p.nombre)}</b> ${tipoTag(p.tipo)}<span class="sub">${esc(p.concentracion)} · ${esc(p.forma)}</span></td>
    <td>${p.fracc ? `<select class="modo" data-modo-i="${i}" aria-label="Presentación"><option value="caja" ${c.modo === 'caja' ? 'selected' : ''}>Caja x${p.upc}</option><option value="unidad" ${c.modo === 'unidad' ? 'selected' : ''}>Unidad</option></select>` : `<span class="muted">${p.upc > 1 ? 'Caja x' + p.upc : 'Unidad'}</span>`}</td>
    <td><span class="qty"><button data-dec="${i}" aria-label="Menos">−</button><input data-q="${i}" value="${c.cant}" inputmode="numeric" aria-label="Cantidad"><button data-inc="${i}" aria-label="Más">+</button></span></td>
    <td class="n">${fmt(pr)}</td><td class="n"><b>${fmt(pr * c.cant)}</b></td>
    <td><button class="icon-btn" data-rm="${i}" aria-label="Quitar">×</button></td></tr>`; }).join('')}
  </tbody></table></div>`;
  const setCant = (i, n) => {
    const c = cart[i], p = prod(c.pid); n = Math.max(1, Math.floor(n) || 1);
    const per = c.modo === 'caja' ? (p.upc || 1) : 1;
    const max = Math.floor((disponible(c.pid) - unidadesEnCarrito(c.pid, c)) / per);
    if (n > max) { toast(`Solo hay ${fmtStock(p, disponible(c.pid))} de ${p.nombre}`, 'bad'); n = Math.max(1, max); }
    c.cant = n; posCart(); posSum();
  };
  $$('[data-inc]', box).forEach(b => b.onclick = () => setCant(+b.dataset.inc, cart[+b.dataset.inc].cant + 1));
  $$('[data-dec]', box).forEach(b => b.onclick = () => setCant(+b.dataset.dec, cart[+b.dataset.dec].cant - 1));
  $$('[data-q]', box).forEach(inp => inp.onchange = () => setCant(+inp.dataset.q, +inp.value));
  $$('[data-rm]', box).forEach(b => b.onclick = () => { cart.splice(+b.dataset.rm, 1); posCart(); posSum(); });
  $$('[data-modo-i]', box).forEach(s => s.onchange = () => {
    const c = cart[+s.dataset.modoI], p = prod(c.pid), old = c.modo; c.modo = s.value;
    if (unidadesEnCarrito(c.pid) > disponible(c.pid)) { c.modo = old; toast(`No alcanza para una caja completa de ${p.nombre}`, 'bad'); }
    const dup = cart.find(x => x !== c && x.pid === c.pid && x.modo === c.modo); if (dup) { dup.cant += c.cant; cart.splice(cart.indexOf(c), 1); }
    posCart(); posSum();
  });
}
function totalesCarrito() {
  let total = 0, base = 0;
  cart.forEach(c => { const p = prod(c.pid); const t = (c.modo === 'caja' ? p.precioCaja : p.precioUnidad) * c.cant; total += t; base += t / (1 + (p.iva || 0) / 100); });
  return { total, base, iva: total - base };
}
function posSum() {
  const box = $('#pos-sum'), { total, base, iva } = totalesCarrito();
  const tipos = new Set(cart.map(c => prod(c.pid).tipo));
  const pideRx = tipos.has('formula') || tipos.has('control'), ctrl = tipos.has('control');
  box.innerHTML = `<h2>Resumen</h2>
    <dl class="sum"><dt>Artículos</dt><dd>${sum(cart, c => c.cant)}</dd><dt>Base</dt><dd>${fmt(base)}</dd><dt>IVA</dt><dd>${fmt(iva)}</dd><dt class="tot">Total</dt><dd class="tot">${fmt(total)}</dd></dl>
    ${pideRx ? `<div class="rx ${ctrl ? 'ctrl' : ''}"><div class="rx-t">${ctrl ? '<span class="tipo control" style="margin:0">Control</span> Medicamento de control especial' : '<span class="tipo formula" style="margin:0">Fórmula</span> Esta venta requiere fórmula médica'}</div>
      ${ctrl && !can('control') ? '<p style="color:var(--bad);font-size:12.5px;font-weight:600">Solo el regente o el administrador pueden dispensar medicamentos de control especial.</p>' : ''}
      ${F('Médico que prescribe', I('rx-med', pos.rx.medico, 'placeholder="Nombre del médico"'))}
      <div class="grid-f form" style="gap:10px">${F('Registro médico', I('rx-reg', pos.rx.registro, 'placeholder="RM"'))}${F('Doc. paciente', I('rx-doc', pos.rx.doc, 'placeholder="CC"'))}</div>
      ${F('Paciente', I('rx-pac', pos.rx.paciente))}</div>` : ''}
    <div class="f"><span>Medio de pago</span><div class="medios">${MEDIOS.map(m => `<button type="button" data-medio="${m}" aria-pressed="${pos.medio === m}">${m}</button>`).join('')}</div></div>
    ${pos.medio === 'Efectivo' ? `${F('Recibe', I('pos-rec', pos.recibe, 'type="number" min="0" step="500" placeholder="' + Math.round(total) + '"'))}<div id="pos-cambio"></div>` : ''}
    <button class="btn primary xl" id="pos-pay" ${cart.length && !cobrando ? '' : 'disabled'}>${cobrando ? 'Registrando…' : 'Cobrar ' + fmt(total)}</button>`;
  $$('[data-medio]', box).forEach(b => b.onclick = () => { pos.medio = b.dataset.medio; posSum(); });
  const rxMap = { 'rx-med': 'medico', 'rx-reg': 'registro', 'rx-doc': 'doc', 'rx-pac': 'paciente' };
  Object.keys(rxMap).forEach(id => { const e = document.getElementById(id); if (e) e.oninput = () => pos.rx[rxMap[id]] = e.value; });
  const rec = $('#pos-rec');
  const upd = () => { const c = $('#pos-cambio'); if (!c) return; const r = num(pos.recibe); c.innerHTML = r ? `<div class="cambio ${r < total ? 'neg' : ''}"><span>${r < total ? 'Falta' : 'Cambio'}</span><span>${fmt(Math.abs(r - total))}</span></div>` : ''; };
  if (rec) { rec.oninput = () => { pos.recibe = rec.value; upd(); }; rec.onkeydown = e => { if (e.key === 'Enter') cobrar(); }; upd(); }
  $('#pos-pay').onclick = cobrar;
}
async function cobrar() {
  if (cobrando) return;
  const caja = cajaAbierta();
  if (!caja) return toast('Abre la caja antes de cobrar', 'bad');
  if (!cart.length) return;
  for (const pid of new Set(cart.map(c => c.pid))) { const p = prod(pid); if (unidadesEnCarrito(pid) > disponible(pid)) return toast(`Sin existencias suficientes de ${p.nombre}`, 'bad'); }
  const tipos = new Set(cart.map(c => prod(c.pid).tipo));
  let formula = null;
  if (tipos.has('formula') || tipos.has('control')) {
    if (tipos.has('control') && !can('control')) return toast('Un regente o administrador debe dispensar el medicamento de control especial', 'bad');
    const r = pos.rx;
    if (!r.medico.trim() || !r.registro.trim() || !r.paciente.trim() || !r.doc.trim()) return toast('Completa los datos de la fórmula médica', 'bad');
    formula = { ...r };
  }
  const { total } = totalesCarrito();
  const recibe = pos.medio === 'Efectivo' ? num(pos.recibe) : 0;
  if (pos.medio === 'Efectivo' && recibe && recibe < total) return toast(`Faltan ${fmt(total - recibe)} para completar el pago`, 'bad');
  if (!navigator.onLine) return toast('Sin conexión a internet. La venta no se registró.', 'bad');
  cobrando = true; posSum();
  try {
    const v = await registrarVenta({ items: cart.map(c => ({ ...c })), medio: pos.medio, recibe, formula, fecha: ahora(), cajaId: caja.id });
    cart = []; pos = { medio: 'Efectivo', recibe: '', q: '', rx: { medico: '', registro: '', paciente: '', doc: '' } };
    cobrando = false;
    if (route === 'vender') vVender();
    verTirilla(v, true);
  } catch (e) { console.error(e); cobrando = false; toast(errMsg(e), 'bad'); if (route === 'vender') posSum(); }
}
function tirilla(v) {
  const i = C.info;
  const porIva = {}; v.items.forEach(it => { porIva[it.iva] = porIva[it.iva] || { base: 0, iva: 0 }; porIva[it.iva].base += it.base; porIva[it.iva].iva += it.total - it.base; });
  const unidad = it => it.modo === 'caja' ? ((it.upc || prod(it.pid)?.upc || 1) > 1 ? 'cj' : 'und') : 'und';
  return `<div class="tirilla">
    <div class="c"><b>${esc((i.nombre || '').toUpperCase())}</b>${i.nit ? '<br>NIT ' + esc(i.nit) : ''}${i.direccion || i.ciudad ? '<br>' + esc([i.direccion, i.ciudad].filter(Boolean).join(' · ')) : ''}${i.telefono ? '<br>Tel. ' + esc(i.telefono) : ''}</div><hr>
    <div class="row"><span>Comprobante</span><b>${v.numero}</b></div><div class="row"><span>Fecha</span><span>${fDT(v.fecha)}</span></div><div class="row"><span>Atendió</span><span>${esc(v.usuario)}</span></div>
    ${v.anulada ? `<hr><div class="c big">*** ANULADA ***</div><div class="c">${esc(v.anulada.motivo)}</div>` : ''}<hr>
    ${v.items.map(it => `<div class="it">${esc(it.nombre)}<div class="row"><span>${it.cant} ${unidad(it)} x ${fmt(it.precio)}${it.iva ? ' (IVA ' + it.iva + '%)' : ''}</span><span>${fmt(it.total)}</span></div><div style="color:#77705f">Lote ${it.lotes.map(l => esc(l.lote)).join(', ')}</div></div>`).join('')}<hr>
    ${Object.keys(porIva).map(k => `<div class="row"><span>Base ${k}%</span><span>${fmt(porIva[k].base)}</span></div>${+k ? `<div class="row"><span>IVA ${k}%</span><span>${fmt(porIva[k].iva)}</span></div>` : ''}`).join('')}
    <div class="row big"><span>TOTAL</span><span>${fmt(v.total)}</span></div>
    <div class="row"><span>${v.pagos[0].medio}</span><span>${fmt(v.pagos[0].medio === 'Efectivo' ? v.recibe : v.total)}</span></div>
    ${v.pagos[0].medio === 'Efectivo' ? `<div class="row"><span>Cambio</span><span>${fmt(v.cambio)}</span></div>` : ''}
    ${v.formula ? `<hr><div>Fórmula: Dr(a). ${esc(v.formula.medico)} · ${esc(v.formula.registro)}<br>Paciente: ${esc(v.formula.paciente)} · ${esc(v.formula.doc)}</div>` : ''}
    <hr><div class="c" style="color:#77705f">Comprobante interno de venta.<br>No es factura electrónica.</div></div>`;
}
function verTirilla(v, nueva) {
  if (!v) return;
  modal(nueva ? 'Venta registrada' : 'Venta ' + v.numero, `${nueva ? `<div class="cambio"><span>${v.pagos[0].medio === 'Efectivo' ? 'Cambio a entregar' : 'Pagado con ' + v.pagos[0].medio}</span><span>${fmt(v.pagos[0].medio === 'Efectivo' ? v.cambio : v.total)}</span></div>` : ''}${tirilla(v)}
    <div class="actions"><span class="grow"></span>${!nueva && !v.anulada && can('anular') ? '<button class="btn danger ghost" id="t-anu">Anular venta</button>' : ''}<button class="btn" id="t-print">Imprimir</button><button class="btn primary" data-close>${nueva ? 'Nueva venta' : 'Cerrar'}</button></div>`,
  { noFocus: true, onMount: r => {
    const a = $('#t-anu', r); if (a) a.onclick = () => pedirAnulacion(v);
    $('#t-print', r).onclick = () => imprimirTirilla(v);
    if (nueva) setTimeout(() => $('[data-close].btn', r)?.focus(), 30);
  } });
}
function imprimirTirilla(v) {
  const w = window.open('', '_blank', 'width=380,height=640');
  if (!w) return toast('El navegador bloqueó la ventana de impresión', 'bad');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${v.numero}</title><style>body{margin:0;font:12px/1.45 ui-monospace,Consolas,monospace}.tirilla{width:72mm;padding:4mm}.c{text-align:center}hr{border:0;border-top:1px dashed #000;margin:6px 0}.row{display:flex;justify-content:space-between;gap:8px}.big{font-size:14px;font-weight:700}.it{margin-bottom:4px}@page{margin:0}</style></head><body>${tirilla(v)}<script>onload=()=>{print();setTimeout(()=>close(),300)}<\/script></body></html>`);
  w.document.close();
}
function pedirAnulacion(v) {
  modal('Anular ' + v.numero, `<p>Las unidades vuelven a sus lotes originales y la venta deja de contar en caja y reportes.</p>
    ${F('Motivo', S('an-m', ['Error en el registro', 'Devolución del cliente', 'Cobro duplicado', 'Otro']))}
    <div class="actions"><span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn danger" id="an-ok">Anular venta</button></div>`,
  { onMount: r => $('#an-ok', r).onclick = e => ocupado(e.currentTarget, async () => { await anularVenta(v, val('an-m')); closeModal(); toast('Venta ' + v.numero + ' anulada'); }) });
}

/* ---------- PRODUCTOS ---------- */
const CATALOGO_EJEMPLO = [
  ['7702000000011', 'Acetaminofén', 'Acetaminofén', '500 mg', 'Tableta', 'Lab. Andino', 'libre', true, 100, 8500, 150, 0, 2, 'Estante A1'],
  ['7702000000028', 'Ibuprofeno', 'Ibuprofeno', '400 mg', 'Tableta', 'Farmasur', 'libre', true, 50, 11000, 300, 0, 2, 'Estante A1'],
  ['7702000000035', 'Loratadina', 'Loratadina', '10 mg', 'Tableta', 'Lab. Andino', 'libre', true, 10, 5500, 700, 0, 3, 'Estante A2'],
  ['7702000000042', 'Amoxicilina', 'Amoxicilina', '500 mg', 'Cápsula', 'Quimiandes', 'formula', true, 50, 19000, 450, 0, 2, 'Estante B1'],
  ['7702000000059', 'Losartán', 'Losartán potásico', '50 mg', 'Tableta', 'Farmasur', 'formula', true, 30, 9500, 380, 0, 3, 'Estante B2'],
  ['7702000000066', 'Metformina', 'Metformina clorhidrato', '850 mg', 'Tableta', 'Quimiandes', 'formula', true, 30, 7800, 300, 0, 3, 'Estante B2'],
  ['7702000000073', 'Omeprazol', 'Omeprazol', '20 mg', 'Cápsula', 'Lab. Andino', 'libre', true, 30, 8200, 350, 0, 2, 'Estante A3'],
  ['7702000000080', 'Sales de rehidratación oral', 'Electrolitos orales', '27,9 g', 'Polvo en sobre', 'Farmasur', 'libre', false, 1, 2800, 0, 0, 15, 'Estante A4'],
  ['7702000000097', 'Jarabe para la tos', 'Dextrometorfano', '15 mg/5 mL', 'Jarabe 120 mL', 'Quimiandes', 'libre', false, 1, 13500, 0, 0, 6, 'Estante A4'],
  ['7702000000103', 'Clonazepam', 'Clonazepam', '2 mg', 'Tableta', 'Lab. Andino', 'control', true, 30, 16000, 650, 0, 1, 'Gabinete bajo llave'],
  ['7702000000110', 'Alcohol antiséptico', 'Alcohol etílico', '70 %', 'Solución 350 mL', 'Farmasur', 'libre', false, 1, 6500, 0, 19, 8, 'Estante C1'],
  ['7702000000127', 'Gasa estéril', '—', '—', 'Sobre x5 (7,5 x 7,5 cm)', 'Quimiandes', 'libre', false, 1, 1800, 0, 19, 20, 'Estante C1'],
  ['7702000000134', 'Termómetro digital', '—', '—', 'Unidad', 'Farmasur', 'libre', false, 1, 18000, 0, 19, 3, 'Vitrina C2'],
  ['7702000000141', 'Diclofenaco gel', 'Diclofenaco sódico', '1 %', 'Gel 50 g', 'Lab. Andino', 'libre', false, 1, 9800, 0, 0, 4, 'Estante A3'],
];
async function cargarCatalogoEjemplo() {
  const b = writeBatch(db);
  CATALOGO_EJEMPLO.forEach((r, i) => b.set(doc(tcol('productos')), { codigo: r[0], nombre: r[1], principio: r[2], concentracion: r[3], forma: r[4], lab: r[5], invima: 'INVIMA EJEMPLO-' + String(i + 1).padStart(4, '0'), tipo: r[6], fracc: r[7], upc: r[8], precioCaja: r[9], precioUnidad: r[10], iva: r[11], stockMin: r[12], ubicacion: r[13] }));
  await b.commit();
  toast('Catálogo de ejemplo cargado. Registra una compra para darle existencias.');
}
function vProductos() {
  const ed = can('editarProducto');
  main.innerHTML = `
  <header class="ph"><div><p class="eyebrow">Catálogo</p><h1>Productos</h1></div>
    <div class="ph-act">${ed ? '<button class="btn" id="p-imp">Importar CSV</button><button class="btn primary" id="p-new">Nuevo producto</button>' : ''}</div></header>
  ${!C.productos.length && ed ? `<div class="banner info"><div><strong>Tu catálogo está vacío.</strong> Crea productos uno por uno, impórtalos desde Excel, o carga 14 productos de ejemplo para probar.</div><button class="btn" id="p-demo">Cargar catálogo de ejemplo</button></div>` : ''}
  <section class="card flush">
    <div class="card-h"><div class="toolbar" style="flex:1">
      <input class="in" id="pq" placeholder="Buscar por nombre, principio activo, código o laboratorio" value="${esc(uiState.prodQ)}" aria-label="Buscar">
      ${S('pt', [['', 'Todos los tipos'], ['libre', 'Venta libre'], ['formula', 'Bajo fórmula'], ['control', 'Control especial']], uiState.prodTipo)}
    </div></div>
    <div class="tbl"><table><thead><tr><th>Producto</th><th>Código</th><th>Presentación</th><th class="n">Precio</th><th class="n">IVA</th><th class="n">Existencia</th><th>Próx. vence</th>${ed ? '<th></th>' : ''}</tr></thead><tbody id="p-body"></tbody></table></div>
  </section>`;
  const body = () => {
    let list = uiState.prodQ.trim() ? buscar(uiState.prodQ) : [...C.productos];
    if (uiState.prodTipo) list = list.filter(p => p.tipo === uiState.prodTipo);
    list.sort((a, b) => a.nombre.localeCompare(b.nombre));
    $('#p-body').innerHTML = list.map(p => { const d = disponible(p.id), l = loteProximo(p.id), bajo = d < (p.stockMin || 0) * (p.upc || 1); return `<tr>
      <td><b>${esc(p.nombre)}</b> ${esc(p.concentracion !== '—' ? p.concentracion : '')}${tipoTag(p.tipo)}<span class="sub">${esc(p.principio)} · ${esc(p.lab)} · ${esc(p.invima)}</span></td>
      <td class="mono">${esc(p.codigo)}</td>
      <td>${esc(p.forma)}<span class="sub">${p.upc > 1 ? 'Caja x' + p.upc : 'Unidad'}${p.fracc ? ' · fraccionable' : ''}</span></td>
      <td class="n">${fmt(p.precioCaja)}${p.fracc ? `<span class="sub">${fmt(p.precioUnidad)} und</span>` : ''}</td>
      <td class="n">${p.iva}%</td>
      <td class="n">${bajo ? `<span class="pill warn">${fmtStock(p, d)}</span>` : fmtStock(p, d)}<span class="sub">mín. ${p.stockMin} ${p.upc > 1 ? 'cj' : 'und'}</span></td>
      <td>${l ? semChip(l.vence) + `<span class="sub">${fDate(l.vence)}</span>` : '<span class="muted">Sin lotes</span>'}</td>
      ${ed ? `<td><button class="btn sm" data-edit="${p.id}">Editar</button></td>` : ''}</tr>`; }).join('') || `<tr><td colspan="8" class="empty">No hay productos que coincidan.</td></tr>`;
    $$('[data-edit]').forEach(b => b.onclick = () => modalProducto(prod(b.dataset.edit)));
  };
  $('#pq').oninput = e => { uiState.prodQ = e.target.value; body(); };
  $('#pt').onchange = e => { uiState.prodTipo = e.target.value; body(); };
  if (ed) { $('#p-new').onclick = () => modalProducto(null); $('#p-imp').onclick = modalImportar; }
  const demo = $('#p-demo'); if (demo) demo.onclick = e => ocupado(e.currentTarget, cargarCatalogoEjemplo);
  body();
}
function modalProducto(p) {
  const e = p || { tipo: 'libre', fracc: false, upc: 1, iva: 0, stockMin: 1, precioCaja: '', precioUnidad: '' };
  modal(p ? 'Editar producto' : 'Nuevo producto', `<form id="fp" class="form grid-f">
    ${F('Nombre', I('p-nom', e.nombre, 'required placeholder="Acetaminofén"'), 'span2')}
    ${F('Principio activo', I('p-pa', e.principio))}
    ${F('Concentración', I('p-conc', e.concentracion, 'placeholder="500 mg"'))}
    ${F('Forma farmacéutica', I('p-forma', e.forma, 'placeholder="Tableta"'))}
    ${F('Laboratorio', I('p-lab', e.lab))}
    ${F('Código de barras', I('p-cod', e.codigo, 'inputmode="numeric" placeholder="770…"'))}
    ${F('Registro INVIMA', I('p-inv', e.invima))}
    ${F('Tipo de venta', S('p-tipo', [['libre', 'Venta libre'], ['formula', 'Bajo fórmula médica'], ['control', 'Control especial']], e.tipo))}
    ${F('IVA', S('p-iva', [[0, '0 % (excluido o exento)'], [5, '5 %'], [19, '19 %']], e.iva))}
    ${F('Unidades por caja', I('p-upc', e.upc, 'type="number" min="1"'))}
    <label class="f chk"><input type="checkbox" id="p-fr" ${e.fracc ? 'checked' : ''}><span>Se vende por unidad (fraccionable)</span></label>
    ${F('Precio caja, IVA incluido', I('p-pc', e.precioCaja, 'type="number" min="0" step="50"'))}
    ${F('Precio por unidad', I('p-pu', e.precioUnidad, 'type="number" min="0" step="50"'))}
    ${F('Stock mínimo (cajas)', I('p-min', e.stockMin, 'type="number" min="0"'))}
    ${F('Ubicación', I('p-ubi', e.ubicacion, 'placeholder="Estante A1"'))}
    <div class="actions span-all">${p ? '<button type="button" class="btn danger ghost" id="p-del">Eliminar</button>' : ''}<span class="grow"></span><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" id="p-save">Guardar</button></div>
  </form>`, { wide: true, onMount: r => {
    $('#fp', r).onsubmit = ev => { ev.preventDefault(); ocupado($('#p-save'), async () => {
      const d = { codigo: val('p-cod'), nombre: val('p-nom'), principio: val('p-pa'), concentracion: val('p-conc') || '—', forma: val('p-forma'), lab: val('p-lab'), invima: val('p-inv'),
        tipo: val('p-tipo'), iva: +val('p-iva'), upc: Math.max(1, Math.floor(num(val('p-upc'))) || 1), fracc: $('#p-fr').checked, precioCaja: num(val('p-pc')), precioUnidad: num(val('p-pu')), stockMin: num(val('p-min')), ubicacion: val('p-ubi') };
      if (!d.nombre) return toast('Escribe el nombre del producto', 'bad');
      if (d.precioCaja <= 0) return toast('Escribe el precio de venta', 'bad');
      if (d.fracc && d.upc < 2) return toast('Un producto fraccionable debe tener más de una unidad por caja', 'bad');
      if (d.fracc && d.precioUnidad <= 0) return toast('Escribe el precio por unidad', 'bad');
      if (d.codigo && C.productos.some(x => x.codigo === d.codigo && x.id !== p?.id)) return toast('Ya existe un producto con ese código de barras', 'bad');
      if (!d.fracc) d.precioUnidad = 0;
      await setDoc(p ? tdoc('productos', p.id) : doc(tcol('productos')), d);
      closeModal(); toast(p ? 'Producto actualizado' : 'Producto creado');
    }); };
    const del = $('#p-del', r);
    if (del) del.onclick = () => {
      if (sum(C.lotes.filter(l => l.pid === p.id), l => l.cant) > 0) return toast('No se puede eliminar: el producto tiene existencias. Da de baja sus lotes primero.', 'bad');
      confirmar(`¿Eliminar <b>${esc(p.nombre)}</b> del catálogo? Las ventas anteriores se conservan.`, 'Eliminar', () => deleteDoc(tdoc('productos', p.id)).then(() => toast('Producto eliminado')).catch(e => toast(errMsg(e), 'bad')));
    };
  } });
}
const CSV_HEAD = 'codigo;nombre;principio_activo;concentracion;forma;laboratorio;invima;tipo_venta;fraccionable;unidades_por_caja;precio_caja;precio_unidad;iva;stock_minimo;ubicacion';
function parseCSV(text) {
  const first = text.split('\n')[0]; const dl = first.split(';').length >= first.split(',').length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === dl) { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
function modalImportar() {
  modal('Importar productos', `<p class="muted">Guarda tu Excel como CSV y súbelo, o pega el contenido. La primera fila debe tener estos encabezados (separados por punto y coma o coma). Si el código ya existe, el producto se actualiza.</p>
    <div class="inline"><code class="mono" style="flex:1;min-width:0;overflow-x:auto;white-space:nowrap;background:var(--surface-2);padding:8px;border-radius:6px">${CSV_HEAD}</code><button class="btn sm" id="im-copy">Copiar</button></div>
    <p class="muted" style="font-size:12.5px">tipo_venta: libre, formula o control · fraccionable: si o no · iva: 0, 5 o 19</p>
    ${F('Archivo CSV', '<input type="file" id="im-file" accept=".csv,text/csv,text/plain" class="in">')}
    ${F('O pega aquí', `<textarea class="in" id="im-txt" placeholder="${CSV_HEAD}"></textarea>`)}
    <div class="actions"><span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn primary" id="im-go">Importar</button></div>`,
  { wide: true, noFocus: true, onMount: r => {
    $('#im-copy', r).onclick = () => copiar(CSV_HEAD, 'Encabezados copiados');
    $('#im-file', r).onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => $('#im-txt').value = rd.result; rd.readAsText(f, 'utf-8'); };
    $('#im-go', r).onclick = e => ocupado(e.currentTarget, async () => {
      const rows = parseCSV($('#im-txt').value); if (rows.length < 2) return toast('No hay filas para importar', 'bad');
      const h = rows[0].map(x => x.trim().toLowerCase()); const ix = k => h.indexOf(k);
      if (ix('nombre') < 0) return toast('Falta la columna "nombre"', 'bad');
      let nuevos = 0, act = 0, err = 0; const ops = [];
      rows.slice(1).forEach(r => {
        const g = k => ix(k) >= 0 ? (r[ix(k)] || '').trim() : '';
        const nombre = g('nombre'); if (!nombre) { err++; return; }
        const tipo = ['libre', 'formula', 'control'].includes(g('tipo_venta').toLowerCase()) ? g('tipo_venta').toLowerCase() : 'libre';
        const upc = Math.max(1, Math.floor(num(g('unidades_por_caja'))) || 1);
        const iva = num(g('iva'));
        const d = { codigo: g('codigo'), nombre, principio: g('principio_activo'), concentracion: g('concentracion') || '—', forma: g('forma'), lab: g('laboratorio'), invima: g('invima'), tipo,
          fracc: /^(si|sí|s|1|true|x)$/i.test(g('fraccionable')) && upc > 1, upc, precioCaja: num(g('precio_caja')), precioUnidad: num(g('precio_unidad')), iva: [0, 5, 19].includes(iva) ? iva : 0, stockMin: num(g('stock_minimo')), ubicacion: g('ubicacion') };
        const ex = d.codigo && C.productos.find(p => p.codigo === d.codigo);
        ops.push([ex ? tdoc('productos', ex.id) : doc(tcol('productos')), d]); ex ? act++ : nuevos++;
      });
      for (let i = 0; i < ops.length; i += 400) { const b = writeBatch(db); ops.slice(i, i + 400).forEach(([ref, d]) => b.set(ref, d)); await b.commit(); }
      closeModal(); toast(`${nuevos} creados · ${act} actualizados${err ? ' · ' + err + ' filas sin nombre' : ''}`);
    });
  } });
}

/* ---------- INVENTARIO Y LOTES ---------- */
function vInventario() {
  const al = alertas(), hoy = hoyISO();
  const activos = C.lotes.filter(l => l.cant > 0);
  const cnt = k => activos.filter(l => semaforo(l.vence).k === k).length;
  const valor = sum(activos, l => l.cant * l.costoU);
  const f = uiState.invFiltro;
  main.innerHTML = `
  <header class="ph"><div><p class="eyebrow">Existencias por lote</p><h1>Inventario y lotes</h1></div>
    <div class="ph-act"><span class="pill">Valor al costo <b class="num">${fmt(valor)}</b></span></div></header>
  <div class="banner info"><div>Semaforización: <b>rojo</b> vence en ${C.config.rojoMeses} meses o menos, <b>amarillo</b> entre ${C.config.rojoMeses} y ${C.config.amarilloMeses} meses, <b>verde</b> más de ${C.config.amarilloMeses} meses. Las ventas descargan primero el lote que vence antes.</div></div>
  <section class="card flush">
    <div class="card-h"><div class="filters" role="group" aria-label="Filtro">
      ${[['todos', `Todos (${activos.length})`], ['venc', `Vencidos (${cnt('venc')})`], ['rojo', `Rojo (${cnt('rojo')})`], ['amar', `Amarillo (${cnt('amar')})`], ['verde', `Verde (${cnt('verde')})`], ['bajo', `Bajo mínimo (${al.bajo.length})`]].map(x => `<button data-f="${x[0]}" aria-pressed="${f === x[0]}">${x[1]}</button>`).join('')}
    </div><input class="in" id="iq" style="flex:0 1 260px" placeholder="Buscar producto o lote" value="${esc(uiState.invQ)}" aria-label="Buscar"></div>
    <div class="tbl" id="inv-t"></div>
  </section>
  <section class="card flush"><div class="card-h"><h2>Bajas registradas</h2></div><div class="tbl"><table><thead><tr><th>Fecha</th><th>Producto</th><th>Lote</th><th>Motivo</th><th class="n">Cantidad</th><th class="n">Costo</th><th>Registró</th></tr></thead><tbody>
    ${[...C.bajas].sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 12).map(b => { const p = prod(b.pid) || { nombre: b.nombre, upc: 1 }; return `<tr><td>${fDT(b.fecha)}</td><td>${esc(p.nombre)}</td><td class="mono">${esc(b.lote)}</td><td>${esc(b.motivo)}${b.obs ? `<span class="sub">${esc(b.obs)}</span>` : ''}</td><td class="n">${fmtStock(p, b.cant)}</td><td class="n">${fmt(b.costo)}</td><td class="muted">${esc(b.usuario)}</td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">Sin bajas registradas.</td></tr>'}
  </tbody></table></div></section>`;
  const table = () => {
    const q = uiState.invQ.trim().toLowerCase();
    if (uiState.invFiltro === 'bajo') {
      const list = al.bajo.filter(p => !q || (p.nombre + ' ' + p.principio).toLowerCase().includes(q));
      $('#inv-t').innerHTML = `<table><thead><tr><th>Producto</th><th class="n">Existencia</th><th class="n">Mínimo</th><th class="n">Faltan para el mínimo</th></tr></thead><tbody>
        ${list.map(p => { const d = disponible(p.id), m = p.stockMin * (p.upc || 1); return `<tr><td><b>${esc(p.nombre)}</b> ${esc(p.concentracion)}<span class="sub">${esc(p.lab)}</span></td><td class="n">${fmtStock(p, d)}</td><td class="n">${fmtStock(p, m)}</td><td class="n"><span class="pill warn">${fmtStock(p, m - d)}</span></td></tr>`; }).join('') || '<tr><td colspan="4" class="empty">Ningún producto está bajo el mínimo.</td></tr>'}</tbody></table>`;
      return;
    }
    let list = activos.filter(l => uiState.invFiltro === 'todos' || semaforo(l.vence).k === uiState.invFiltro);
    if (q) list = list.filter(l => { const p = prod(l.pid) || {}; return (p.nombre + ' ' + p.principio + ' ' + l.lote).toLowerCase().includes(q); });
    list.sort(ordenFEFO);
    $('#inv-t').innerHTML = `<table><thead><tr><th>Producto</th><th>Lote</th><th>Vence</th><th>Semáforo</th><th class="n">Existencia</th><th class="n">Costo</th>${can('baja') ? '<th></th>' : ''}</tr></thead><tbody>
      ${list.map(l => { const p = prod(l.pid) || { nombre: '(producto eliminado)', concentracion: '', lab: '', upc: 1 }; const d = diffDays(l.vence, hoy); return `<tr><td><b>${esc(p.nombre)}</b> ${esc(p.concentracion)}${tipoTag(p.tipo)}<span class="sub">${esc(p.lab)} · ${esc(p.ubicacion || '')}</span></td><td class="mono">${esc(l.lote)}</td>
        <td>${fDate(l.vence)}<span class="sub">${d < 0 ? `vencido hace ${-d} días` : `en ${d} días`}</span></td><td>${semChip(l.vence)}</td><td class="n">${fmtStock(p, l.cant)}</td><td class="n">${fmt(l.cant * l.costoU)}</td>
        ${can('baja') ? `<td><button class="btn sm" data-baja="${l.id}">Dar de baja</button></td>` : ''}</tr>`; }).join('') || '<tr><td colspan="7" class="empty">No hay lotes en este filtro.</td></tr>'}</tbody></table>`;
    $$('[data-baja]').forEach(b => b.onclick = () => modalBaja(C.lotes.find(l => l.id === b.dataset.baja)));
  };
  $$('[data-f]').forEach(b => b.onclick = () => { uiState.invFiltro = b.dataset.f; $$('[data-f]').forEach(x => x.setAttribute('aria-pressed', x === b)); table(); });
  $('#iq').oninput = e => { uiState.invQ = e.target.value; table(); };
  table();
}
function modalBaja(l) {
  const p = prod(l.pid) || { nombre: '(producto eliminado)', upc: 1 }, venc = l.vence < hoyISO();
  modal('Dar de baja', `<p><b>${esc(nombreProd(p))}</b><br><span class="muted">Lote <span class="mono">${esc(l.lote)}</span> · vence ${fDate(l.vence)} · existencia ${fmtStock(p, l.cant)}</span></p>
    <div class="form grid-f">${F('Cantidad (unidades)', I('bj-c', l.cant, `type="number" min="1" max="${l.cant}"`))}${F('Motivo', S('bj-m', MOTIVOS, venc ? 'Vencido' : 'Averiado'))}${F('Observación', I('bj-o', '', 'placeholder="Opcional"'), 'span2')}</div>
    <div class="actions"><span class="grow"></span><button class="btn" data-close>Cancelar</button><button class="btn danger" id="bj-ok">Registrar baja</button></div>`,
  { onMount: r => $('#bj-ok', r).onclick = e => ocupado(e.currentTarget, async () => {
    const c = Math.floor(num(val('bj-c')));
    if (c < 1) return toast('Escribe una cantidad válida', 'bad');
    const motivo = val('bj-m'), obs = val('bj-o');
    await runTransaction(db, async tx => {
      const ref = tdoc('lotes', l.id), s = await tx.get(ref);
      const actual = s.data()?.cant || 0;
      if (c > actual) throw new Error(`Solo quedan ${actual} unidades en este lote.`);
      tx.update(ref, { cant: actual - c, ultimoMov: 'baja' });
      tx.set(doc(tcol('bajas')), { fecha: ahora(), dia: hoyISO(), pid: l.pid, nombre: p.nombre, loteId: l.id, lote: l.lote, cant: c, costo: c * s.data().costoU, motivo, obs, userId: fbUser.uid, usuario: U().nombre });
    });
    closeModal(); toast('Baja registrada');
  }) });
}

/* ---------- COMPRAS ---------- */
let compraDraft = null;
const nuevaLinea = () => ({ pid: '', lote: '', vence: '', cajas: 1, costoCaja: '' });
function vCompras() {
  if (compraDraft) return vCompraForm();
  main.innerHTML = `
  <header class="ph"><div><p class="eyebrow">Entradas de mercancía</p><h1>Compras</h1></div>
    <div class="ph-act"><button class="btn primary" id="c-new">Registrar compra</button></div></header>
  <section class="card flush"><div class="tbl"><table><thead><tr><th>Fecha</th><th>Proveedor</th><th>Factura</th><th class="n">Líneas</th><th class="n">Total</th><th>Registró</th><th></th></tr></thead><tbody>
    ${[...C.compras].sort((a, b) => b.fecha.localeCompare(a.fecha)).map(c => `<tr><td>${fDate(c.fecha)}</td><td><b>${esc(prov(c.provId)?.nombre || c.proveedor || '—')}</b></td><td class="mono">${esc(c.factura)}</td><td class="n">${c.lineas.length}</td><td class="n"><b>${fmt(c.total)}</b></td><td class="muted">${esc(c.usuario)}</td><td><button class="btn sm" data-ver="${c.id}">Ver</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Aún no hay compras registradas.</td></tr>'}
  </tbody></table></div></section>`;
  $('#c-new').onclick = () => {
    if (!C.proveedores.length) { toast('Primero crea un proveedor', 'bad'); return go('proveedores'); }
    if (!C.productos.length) { toast('Primero crea productos en el catálogo', 'bad'); return go('productos'); }
    compraDraft = { fecha: hoyISO(), provId: C.proveedores[0].id, factura: '', lineas: [nuevaLinea()] }; vCompras();
  };
  $$('[data-ver]').forEach(b => b.onclick = () => {
    const c = C.compras.find(x => x.id === b.dataset.ver);
    modal('Compra ' + c.factura, `<p class="muted">${esc(prov(c.provId)?.nombre || c.proveedor || '')} · ${fDate(c.fecha)} · registró ${esc(c.usuario)}</p>
      <div class="tbl" style="margin-inline:-20px"><table><thead><tr><th>Producto</th><th>Lote</th><th>Vence</th><th class="n">Cajas</th><th class="n">Costo caja</th><th class="n">Subtotal</th></tr></thead><tbody>
      ${c.lineas.map(l => `<tr><td>${esc(prod(l.pid)?.nombre || l.nombre)}</td><td class="mono">${esc(l.lote)}</td><td>${fDate(l.vence)}</td><td class="n">${l.cajas}</td><td class="n">${fmt(l.costoCaja)}</td><td class="n">${fmt(l.cajas * l.costoCaja)}</td></tr>`).join('')}
      </tbody></table></div><div class="actions"><span class="grow"></span><b>Total ${fmt(c.total)}</b></div>`, { wide: true, noFocus: true });
  });
}
function vCompraForm() {
  const d = compraDraft;
  const prods = [...C.productos].sort((a, b) => a.nombre.localeCompare(b.nombre));
  main.innerHTML = `
  <header class="ph"><div><p class="eyebrow">Compras</p><h1>Registrar compra</h1></div>
    <div class="ph-act"><button class="btn" id="cf-cancel">Cancelar</button></div></header>
  <section class="card"><div class="form grid-f" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
    ${F('Proveedor', S('cf-prov', C.proveedores.map(p => [p.id, p.nombre]), d.provId))}
    ${F('Número de factura', I('cf-fac', d.factura, 'placeholder="FE-10234"'))}
    ${F('Fecha de recepción', I('cf-fecha', d.fecha, 'type="date"'))}
  </div></section>
  <section class="card flush"><div class="card-h"><h2>Productos recibidos</h2><span class="muted" style="font-size:12.5px">Registra lote y fecha de vencimiento tal como vienen en el empaque</span></div>
    <div class="tbl"><table class="lines"><thead><tr><th style="min-width:220px">Producto</th><th>Lote</th><th>Vence</th><th class="n">Cajas</th><th class="n">Costo por caja</th><th class="n">Subtotal</th><th></th></tr></thead><tbody>
    ${d.lineas.map((l, i) => `<tr>
      <td><select class="in" data-k="pid" data-i="${i}" aria-label="Producto"><option value="">Selecciona…</option>${prods.map(p => `<option value="${p.id}" ${p.id === l.pid ? 'selected' : ''}>${esc(p.nombre + ' ' + (p.concentracion !== '—' ? p.concentracion : '') + ' · ' + (p.upc > 1 ? 'x' + p.upc : 'und'))}</option>`).join('')}</select></td>
      <td><input class="in mono" data-k="lote" data-i="${i}" value="${esc(l.lote)}" style="width:110px" aria-label="Lote"></td>
      <td><input class="in" type="date" data-k="vence" data-i="${i}" value="${esc(l.vence)}" aria-label="Vencimiento"></td>
      <td class="n"><input class="in" type="number" min="1" data-k="cajas" data-i="${i}" value="${esc(l.cajas)}" style="width:76px;text-align:right" aria-label="Cajas"></td>
      <td class="n"><input class="in" type="number" min="0" step="50" data-k="costoCaja" data-i="${i}" value="${esc(l.costoCaja)}" style="width:120px;text-align:right" aria-label="Costo por caja"></td>
      <td class="n" data-sub="${i}"></td>
      <td><button class="icon-btn" data-rml="${i}" aria-label="Quitar línea">×</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="card-h" style="border-top:1px solid var(--line-2);border-bottom:0"><button class="btn" id="cl-add">+ Agregar línea</button><div class="inline"><span class="muted">Total factura</span><b class="num" id="cl-tot" style="font-size:20px;font-family:var(--f-display)"></b><button class="btn primary" id="cf-save">Guardar compra</button></div></div>
  </section>`;
  const recalc = () => {
    d.lineas.forEach((l, i) => { const c = $(`[data-sub="${i}"]`); const p = prod(l.pid); const s = num(l.cajas) * num(l.costoCaja);
      c.innerHTML = fmt(s) + (p && num(l.costoCaja) > 0 && num(l.costoCaja) >= p.precioCaja ? '<span class="sub" style="color:var(--bad)">Costo ≥ precio de venta</span>' : ''); });
    $('#cl-tot').textContent = fmt(sum(d.lineas, l => num(l.cajas) * num(l.costoCaja)));
  };
  $$('[data-k]').forEach(e => e.addEventListener('input', () => { d.lineas[+e.dataset.i][e.dataset.k] = e.value; recalc(); }));
  $('#cf-prov').onchange = e => d.provId = e.target.value;
  $('#cf-fac').oninput = e => d.factura = e.target.value;
  $('#cf-fecha').oninput = e => d.fecha = e.target.value;
  $('#cl-add').onclick = () => { d.lineas.push(nuevaLinea()); vCompraForm(); };
  $$('[data-rml]').forEach(b => b.onclick = () => { d.lineas.splice(+b.dataset.rml, 1); if (!d.lineas.length) d.lineas.push(nuevaLinea()); vCompraForm(); });
  $('#cf-cancel').onclick = () => { compraDraft = null; vCompras(); };
  $('#cf-save').onclick = e => ocupado(e.currentTarget, guardarCompra);
  recalc();
}
async function guardarCompra() {
  const d = compraDraft, hoy = hoyISO();
  if (!d.factura.trim()) return toast('Escribe el número de factura del proveedor', 'bad');
  if (!d.fecha) return toast('Escribe la fecha de recepción', 'bad');
  const lineas = d.lineas.filter(l => l.pid);
  if (!lineas.length) return toast('Agrega al menos un producto', 'bad');
  for (const l of lineas) {
    const p = prod(l.pid);
    if (!l.lote.trim()) return toast(`Falta el lote de ${p.nombre}`, 'bad');
    if (!l.vence) return toast(`Falta la fecha de vencimiento de ${p.nombre}`, 'bad');
    if (l.vence <= hoy) return toast(`${p.nombre}: el lote ${l.lote} ya está vencido. No se puede recibir.`, 'bad');
    if (num(l.cajas) < 1) return toast(`Revisa la cantidad de ${p.nombre}`, 'bad');
    if (num(l.costoCaja) <= 0) return toast(`Falta el costo de ${p.nombre}`, 'bad');
  }
  const compraRef = doc(tcol('compras'));
  const lin = lineas.map(l => ({ pid: l.pid, nombre: prod(l.pid).nombre, lote: l.lote.trim().toUpperCase(), vence: l.vence, cajas: Math.floor(num(l.cajas)), costoCaja: num(l.costoCaja) }));
  await runTransaction(db, async tx => {
    // Si el mismo lote ya existe (con existencias), se suma a él
    const existentes = {};
    for (const l of lin) {
      const ex = C.lotes.find(x => x.pid === l.pid && x.lote === l.lote && x.vence === l.vence);
      if (ex && !existentes[ex.id]) { const s = await tx.get(tdoc('lotes', ex.id)); if (s.exists()) existentes[ex.id] = { ...s.data() }; }
    }
    for (const l of lin) {
      const upc = prod(l.pid).upc || 1;
      const exId = Object.keys(existentes).find(id => existentes[id].pid === l.pid && existentes[id].lote === l.lote && existentes[id].vence === l.vence);
      if (exId) { const e = existentes[exId]; const tot = e.cant * e.costoU + l.cajas * l.costoCaja; e.cant += l.cajas * upc; e.costoU = tot / e.cant; }
      else tx.set(doc(tcol('lotes')), { pid: l.pid, lote: l.lote, vence: l.vence, cant: l.cajas * upc, costoU: l.costoCaja / upc, compraId: compraRef.id, ingreso: d.fecha });
    }
    Object.keys(existentes).forEach(id => tx.update(tdoc('lotes', id), { cant: existentes[id].cant, costoU: existentes[id].costoU, ultimoMov: compraRef.id }));
    tx.set(compraRef, { fecha: d.fecha, provId: d.provId, proveedor: prov(d.provId)?.nombre || '', factura: d.factura.trim(), lineas: lin, total: sum(lin, l => l.cajas * l.costoCaja), userId: fbUser.uid, usuario: U().nombre });
  });
  compraDraft = null; toast('Compra registrada. Los lotes ya están en inventario.'); vCompras();
}

/* ---------- PROVEEDORES ---------- */
function vProveedores() {
  main.innerHTML = `
  <header class="ph"><div><p class="eyebrow">Compras</p><h1>Proveedores</h1></div><div class="ph-act"><button class="btn primary" id="pv-new">Nuevo proveedor</button></div></header>
  <section class="card flush"><div class="tbl"><table><thead><tr><th>Proveedor</th><th>NIT</th><th>Contacto</th><th>Teléfono</th><th>Ciudad</th><th class="n">Compras (12 meses)</th><th></th></tr></thead><tbody>
  ${[...C.proveedores].sort((a, b) => a.nombre.localeCompare(b.nombre)).map(p => { const cs = C.compras.filter(c => c.provId === p.id); return `<tr><td><b>${esc(p.nombre)}</b><span class="sub">${esc(p.correo)}</span></td><td class="mono">${esc(p.nit)}</td><td>${esc(p.contacto)}</td><td class="mono">${esc(p.telefono)}</td><td>${esc(p.ciudad)}</td><td class="n">${cs.length}<span class="sub">${fmt(sum(cs, c => c.total))}</span></td><td><button class="btn sm" data-pv="${p.id}">Editar</button></td></tr>`; }).join('') || '<tr><td colspan="7" class="empty">Sin proveedores. Crea el primero para poder registrar compras.</td></tr>'}
  </tbody></table></div></section>`;
  const m = p => {
    const e = p || {};
    modal(p ? 'Editar proveedor' : 'Nuevo proveedor', `<form id="fpv" class="form grid-f">
      ${F('Razón social', I('pv-n', e.nombre, 'required'), 'span2')}${F('NIT', I('pv-nit', e.nit, 'placeholder="900.000.000-0"'))}${F('Ciudad', I('pv-c', e.ciudad))}
      ${F('Contacto / asesor', I('pv-ct', e.contacto))}${F('Teléfono', I('pv-t', e.telefono, 'inputmode="tel"'))}${F('Correo', I('pv-e', e.correo, 'type="email"'), 'span2')}
      <div class="actions span-all"><span class="grow"></span><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" id="pv-save">Guardar</button></div></form>`,
    { onMount: r => $('#fpv', r).onsubmit = ev => { ev.preventDefault(); ocupado($('#pv-save'), async () => {
      const d = { nombre: val('pv-n'), nit: val('pv-nit'), ciudad: val('pv-c'), contacto: val('pv-ct'), telefono: val('pv-t'), correo: val('pv-e') };
      if (!d.nombre) return toast('Escribe la razón social', 'bad');
      await setDoc(p ? tdoc('proveedores', p.id) : doc(tcol('proveedores')), d);
      closeModal(); toast('Proveedor guardado');
    }); } });
  };
  $('#pv-new').onclick = () => m(null);
  $$('[data-pv]').forEach(b => b.onclick = () => m(prov(b.dataset.pv)));
}

/* ---------- CAJA ---------- */
function vCaja() {
  const c = cajaAbierta();
  const hist = C.cajas.filter(x => x.cierre).sort((a, b) => b.apertura.localeCompare(a.apertura)).slice(0, 20);
  let actual;
  if (c) {
    const e = esperadoCaja(c);
    actual = `<section class="card"><div class="card-h"><h2>Caja abierta</h2><span class="pill ok">Desde ${fDT(c.apertura)} · ${esc(c.usuario)}</span></div>
      <div class="grid2">
        <div><p class="sec-t" style="margin-bottom:8px">Movimiento del turno</p><dl class="sum"><dt>Base inicial</dt><dd>${fmt(c.base)}</dd>
          ${MEDIOS.map(m => e.por[m] ? `<dt>Ventas en ${m.toLowerCase()}</dt><dd>${fmt(e.por[m])}</dd>` : '').join('')}
          <dt>Número de ventas</dt><dd>${e.n}</dd><dt class="tot">Efectivo esperado</dt><dd class="tot">${fmt(e.efectivo)}</dd></dl></div>
        <form id="fcz" class="form"><p class="sec-t">Cierre y arqueo</p>
          ${F('Efectivo contado en caja', I('cz-c', '', 'type="number" min="0" step="50" required placeholder="' + Math.round(e.efectivo) + '"'))}
          <div id="cz-dif"></div>
          ${F('Observación', I('cz-o', '', 'placeholder="Opcional"'))}
          <button class="btn primary" id="cz-go">Cerrar caja</button></form>
      </div></section>`;
  } else {
    actual = `<section class="card"><h2>Abrir caja</h2><p class="muted">Registra el efectivo con el que inicia el turno (base). Desde ese momento se pueden registrar ventas en cualquier equipo de la droguería.</p>
      <div class="inline" style="max-width:420px"><label class="sr" for="ab-base2">Base</label><input id="ab-base2" class="in" type="number" min="0" step="1000" value="150000"><button class="btn primary" id="ab-go2">Abrir caja</button></div></section>`;
  }
  main.innerHTML = `<header class="ph"><div><p class="eyebrow">Turnos y arqueo</p><h1>Caja</h1></div></header>${actual}
  <section class="card flush"><div class="card-h"><h2>Cierres anteriores</h2></div><div class="tbl"><table><thead><tr><th>Apertura</th><th>Cierre</th><th>Responsable</th><th class="n">Ventas</th><th class="n">Efectivo esperado</th><th class="n">Contado</th><th class="n">Diferencia</th></tr></thead><tbody>
  ${hist.map(h => `<tr><td>${fDT(h.apertura)}<span class="sub">${esc(h.usuario)}</span></td><td>${fDT(h.cierre.fecha)}<span class="sub">${esc(h.cierre.usuario || '')}</span></td><td>${esc(h.cierre.obs || '')}</td><td class="n">${fmt(h.cierre.total)}</td><td class="n">${fmt(h.cierre.esperado)}</td><td class="n">${fmt(h.cierre.contado)}</td><td class="n">${h.cierre.dif === 0 ? '<span class="pill ok">Cuadrada</span>' : `<span class="pill ${h.cierre.dif < 0 ? 'bad' : 'warn'}">${h.cierre.dif > 0 ? '+' : ''}${fmt(h.cierre.dif)}</span>`}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Sin cierres registrados.</td></tr>'}
  </tbody></table></div></section>`;
  if (c) {
    const e = esperadoCaja(c);
    $('#cz-c').oninput = ev => { const v = num(ev.target.value), dif = v - e.efectivo; $('#cz-dif').innerHTML = ev.target.value ? `<div class="cambio ${dif < 0 ? 'neg' : ''}"><span>${dif === 0 ? 'Caja cuadrada' : dif < 0 ? 'Faltante' : 'Sobrante'}</span><span>${fmt(Math.abs(dif))}</span></div>` : ''; };
    $('#fcz').onsubmit = ev => { ev.preventDefault();
      if (!val('cz-c')) return toast('Escribe el efectivo contado', 'bad');
      const contado = num(val('cz-c')), obs = val('cz-o');
      confirmar(`¿Cerrar la caja con <b>${fmt(contado)}</b> en efectivo? Diferencia: <b>${fmt(contado - e.efectivo)}</b>.`, 'Cerrar caja',
        () => cerrarCaja(c, contado, obs).then(() => toast('Caja cerrada')).catch(err => toast(errMsg(err), 'bad')), false);
    };
  } else $('#ab-go2').onclick = e => ocupado(e.currentTarget, () => abrirCaja(num(val('ab-base2'))));
}

/* ---------- REPORTES ---------- */
function vReportes() {
  const hoy = hoyISO(), minimo = addDays(hoy, -VENTANA);
  const r = uiState.repRango;
  let desde = uiState.repDesde, hasta = uiState.repHasta;
  if (r !== 'custom') { hasta = hoy; desde = r === 'hoy' ? hoy : r === 'mes' ? hoy.slice(0, 8) + '01' : addDays(hoy, -(+r - 1)); }
  if (!desde || desde < minimo) desde = minimo;
  if (!hasta || hasta > hoy) hasta = hoy;
  const vsAll = C.ventas.filter(v => v.dia >= desde && v.dia <= hasta);
  const vs = vsAll.filter(v => !v.anulada);
  const tot = sum(vs, v => v.total), costo = sum(vs, v => v.costo), base = sum(vs, v => v.base), gan = base - costo;
  const dias = {}; for (let d = desde, k = 0; d <= hasta && k < 400; d = addDays(d, 1), k++) dias[d] = { n: 0, t: 0 };
  vs.forEach(v => { if (dias[v.dia]) { dias[v.dia].n++; dias[v.dia].t += v.total; } });
  const maxD = Math.max(1, ...Object.values(dias).map(x => x.t));
  const medios = {}; vs.forEach(v => v.pagos.forEach(p => medios[p.medio] = (medios[p.medio] || 0) + p.valor));
  const top = {}; vs.forEach(v => v.items.forEach(i => { top[i.pid] = top[i.pid] || { n: i.nombre, u: 0, t: 0, c: 0, b: 0 }; top[i.pid].u += i.units; top[i.pid].t += i.total; top[i.pid].c += i.costo; top[i.pid].b += i.base; }));
  const topL = Object.entries(top).sort((a, b) => b[1].t - a[1].t).slice(0, 10);
  const bajas = C.bajas.filter(b => b.dia >= desde && b.dia <= hasta);
  main.innerHTML = `
  <header class="ph"><div><p class="eyebrow">Análisis</p><h1>Reportes</h1></div>
    <div class="ph-act filters" role="group" aria-label="Periodo">${[['hoy', 'Hoy'], ['7', '7 días'], ['30', '30 días'], ['mes', 'Este mes'], ['custom', 'Rango']].map(x => `<button data-r="${x[0]}" aria-pressed="${r === x[0]}">${x[1]}</button>`).join('')}</div></header>
  ${r === 'custom' ? `<div class="inline" style="max-width:560px">${F('Desde', I('rp-d', desde, `type="date" min="${minimo}"`))}${F('Hasta', I('rp-h', hasta, `type="date" min="${minimo}"`))}</div><p class="muted" style="font-size:12.5px">Los reportes cubren los últimos ${VENTANA} días.</p>` : ''}
  <section class="kpis">
    ${kpi('Ventas', fmt(tot), `${vs.length} ventas · ${fDate(desde)} a ${fDate(hasta)}`)}
    ${kpi('Ticket promedio', vs.length ? fmt(tot / vs.length) : '—', 'por venta')}
    ${kpi('Ganancia aproximada', fmt(gan), `Ventas sin IVA ${fmt(base)} − costo ${fmt(costo)}`, gan >= 0 ? 'ok' : 'warn')}
    ${kpi('Margen', base ? Math.round(gan / base * 100) + ' %' : '—', `Bajas del periodo: ${fmt(sum(bajas, b => b.costo))}`)}
  </section>
  <div class="grid2">
    <section class="card flush"><div class="card-h"><h2>Ventas por día</h2></div><div class="tbl"><table><thead><tr><th>Día</th><th class="n">Ventas</th><th class="n">Total</th><th style="width:34%"></th></tr></thead><tbody>
      ${Object.entries(dias).reverse().slice(0, 31).map(([d, x]) => `<tr><td>${fDate(d)}</td><td class="n">${x.n}</td><td class="n">${fmt(x.t)}</td><td><div class="bar"><i style="width:${(x.t / maxD * 100).toFixed(1)}%"></i></div></td></tr>`).join('')}
    </tbody></table></div></section>
    <section class="card flush"><div class="card-h"><h2>Por medio de pago</h2></div><div class="tbl"><table><thead><tr><th>Medio</th><th class="n">Total</th><th class="n">Participación</th></tr></thead><tbody>
      ${Object.entries(medios).sort((a, b) => b[1] - a[1]).map(([m, t]) => `<tr><td>${m}</td><td class="n">${fmt(t)}</td><td class="n">${tot ? Math.round(t / tot * 100) : 0} %</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Sin ventas en el periodo.</td></tr>'}
    </tbody></table></div></section>
  </div>
  <section class="card flush"><div class="card-h"><h2>Productos más vendidos</h2></div><div class="tbl"><table><thead><tr><th>Producto</th><th class="n">Unidades</th><th class="n">Ventas</th><th class="n">Costo</th><th class="n">Margen</th></tr></thead><tbody>
    ${topL.map(([pid, x]) => { const p = prod(pid); return `<tr><td>${esc(x.n)}</td><td class="n">${p ? fmtStock(p, x.u) : x.u + ' und'}</td><td class="n">${fmt(x.t)}</td><td class="n">${fmt(x.c)}</td><td class="n">${x.b ? Math.round((x.b - x.c) / x.b * 100) : 0} %</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">Sin ventas en el periodo.</td></tr>'}
  </tbody></table></div></section>
  <section class="card flush"><div class="card-h"><h2>Detalle de ventas</h2><span class="muted" style="font-size:12.5px">${vsAll.length - vs.length} anulada${vsAll.length - vs.length === 1 ? '' : 's'}</span></div><div class="tbl"><table><thead><tr><th>Venta</th><th>Fecha</th><th>Vendedor</th><th>Medio</th><th class="n">Artículos</th><th class="n">Total</th><th></th></tr></thead><tbody>
    ${[...vsAll].sort((a, b) => b.fecha.localeCompare(a.fecha)).slice(0, 100).map(v => `<tr class="${v.anulada ? 'anul' : ''}"><td class="mono">${v.numero}${v.formula ? ' <span class="tipo formula">Rx</span>' : ''}</td><td>${fDT(v.fecha)}</td><td>${esc(v.usuario)}</td><td>${v.pagos[0].medio}</td><td class="n">${sum(v.items, i => i.cant)}</td><td class="n"><b>${fmt(v.total)}</b></td><td><button class="btn sm" data-tir="${v.id}">Ver</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Sin ventas en el periodo.</td></tr>'}
  </tbody></table></div></section>`;
  $$('[data-r]').forEach(b => b.onclick = () => { uiState.repRango = b.dataset.r; if (b.dataset.r === 'custom') { uiState.repDesde = desde; uiState.repHasta = hasta; } vReportes(); });
  if (r === 'custom') { $('#rp-d').onchange = e => { uiState.repDesde = e.target.value; vReportes(); }; $('#rp-h').onchange = e => { uiState.repHasta = e.target.value; vReportes(); }; }
  $$('[data-tir]').forEach(b => b.onclick = () => verTirilla(C.ventas.find(v => v.id === b.dataset.tir)));
}

/* ---------- CONFIGURACIÓN ---------- */
function vConfig() {
  const i = C.info, c = C.config;
  main.innerHTML = `
  <header class="ph"><div><p class="eyebrow">Administración</p><h1>Configuración</h1></div></header>
  <div class="grid2">
    <section class="card"><h2>Datos de la droguería</h2><form id="fi" class="form grid-f">
      ${F('Nombre comercial', I('i-n', i.nombre), 'span2')}${F('NIT', I('i-nit', i.nit))}${F('Teléfono', I('i-t', i.telefono))}
      ${F('Dirección', I('i-d', i.direccion))}${F('Ciudad / municipio', I('i-c', i.ciudad))}
      ${F('Director técnico / responsable', I('i-r', i.responsable), 'span2')}
      <div class="actions span-all"><span class="grow"></span><button class="btn primary" id="i-save">Guardar datos</button></div></form></section>
    <section class="card"><h2>Reglas de operación</h2><form id="fc" class="form grid-f">
      ${F('Semáforo rojo: vence en (meses)', I('c-r', c.rojoMeses, 'type="number" min="1" max="24"'))}
      ${F('Semáforo amarillo: hasta (meses)', I('c-a', c.amarilloMeses, 'type="number" min="2" max="36"'))}
      ${F('Prefijo de comprobantes', I('c-p', c.prefijo, 'maxlength="4"'))}
      ${F('Último comprobante', I('c-s', (c.prefijo || 'V') + '-' + String(C.seq.venta).padStart(6, '0'), 'disabled'))}
      <div class="actions span-all"><span class="grow"></span><button class="btn primary" id="c-save">Guardar reglas</button></div></form></section>
  </div>
  <section class="card flush"><div class="card-h"><div><h2>Usuarios</h2><p class="muted" style="font-size:12.5px">Cada persona entra con su propio correo y contraseña.</p></div><button class="btn primary sm" id="u-new">Nuevo usuario</button></div><div class="tbl"><table><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th></th></tr></thead><tbody>
    ${[...C.usuarios].sort((a, b) => a.nombre.localeCompare(b.nombre)).map(u => `<tr><td><b>${esc(u.nombre)}</b>${u.id === C.ownerUid ? ' <span class="pill acc">Dueño</span>' : ''}${u.doc ? `<span class="sub">${esc(u.doc)}</span>` : ''}</td><td>${esc(u.email)}</td><td>${ROLES[u.rol]}</td><td>${u.activo === false ? '<span class="pill">Inactivo</span>' : '<span class="pill ok">Activo</span>'}</td><td><button class="btn sm" data-us="${u.id}">Editar</button></td></tr>`).join('')}
  </tbody></table></div></section>
  <section class="card"><h2>Cuenta en la plataforma</h2>
    <p>${C.estado === 'prueba' ? `Estás en el periodo de prueba. Te quedan <b>${diasPrueba()} días</b>.` : C.estado === 'activa' ? 'La cuenta de esta droguería está <b>activa</b>.' : 'La cuenta está suspendida.'}</p>
    <p class="muted">Soporte: ${esc(soporte?.nombre || '')}${soporte?.telefono ? ' · ' + esc(soporte.telefono) : ''}${soporte?.correo ? ' · ' + esc(soporte.correo) : ''}</p>
    <div class="actions"><button class="btn" id="bk-copy">Copiar datos (JSON)</button><span class="muted" style="font-size:12.5px">Copia de los datos cargados en pantalla, por si quieres guardarla aparte.</span></div></section>`;
  $('#fi').onsubmit = e => { e.preventDefault(); ocupado($('#i-save'), async () => {
    if (!val('i-n')) return toast('Escribe el nombre de la droguería', 'bad');
    await updateDoc(doc(db, 'tenants', TID), { info: { nombre: val('i-n'), nit: val('i-nit'), telefono: val('i-t'), direccion: val('i-d'), ciudad: val('i-c'), responsable: val('i-r') } });
    toast('Datos guardados');
  }); };
  $('#fc').onsubmit = e => { e.preventDefault(); ocupado($('#c-save'), async () => {
    const r = Math.floor(num(val('c-r'))), a = Math.floor(num(val('c-a')));
    if (r < 1 || a <= r || a > 36) return toast('El límite amarillo debe ser mayor que el rojo (máximo 36 meses)', 'bad');
    await updateDoc(doc(db, 'tenants', TID), { config: { rojoMeses: r, amarilloMeses: a, prefijo: (val('c-p') || 'V').toUpperCase().slice(0, 4) } });
    toast('Reglas guardadas');
  }); };
  $('#u-new').onclick = () => modalUsuario(null);
  $$('[data-us]').forEach(b => b.onclick = () => modalUsuario(C.usuarios.find(u => u.id === b.dataset.us)));
  $('#bk-copy').onclick = () => { const { listo, datosIniciados, ...datos } = C; copiar(JSON.stringify(datos), 'Datos copiados'); };
}
function modalUsuario(u) {
  const e = u || { rol: 'vendedor', activo: true };
  modal(u ? 'Editar usuario' : 'Nuevo usuario', `<form id="fu" class="form grid-f">
    ${F('Nombre completo', I('u-n', e.nombre, 'required'), 'span2')}
    ${u ? F('Correo', I('u-m', e.email, 'disabled'), 'span2') : F('Correo con el que entrará', I('u-m', '', 'type="email" required autocomplete="off"'), 'span2')}
    ${u ? '' : F('Contraseña inicial (mínimo 6)', I('u-p', '', 'type="text" required minlength="6" autocomplete="off"'), 'span2')}
    ${F('Documento', I('u-d', e.doc))}${F('Rol', S('u-r', Object.entries(ROLES), e.rol))}
    ${u ? `<label class="f chk span2" style="padding-top:0"><input type="checkbox" id="u-a" ${e.activo !== false ? 'checked' : ''}><span>Usuario activo (desmarca para quitarle el acceso)</span></label>` : ''}
    <div class="actions span-all">${u ? '<button type="button" class="btn ghost" id="u-reset">Enviar correo para cambiar contraseña</button>' : ''}<span class="grow"></span><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" id="u-save">Guardar</button></div></form>
    ${u ? '' : '<p class="muted" style="font-size:12.5px">Entrega la contraseña inicial a la persona. Puede cambiarla con "Olvidé mi contraseña" en la pantalla de ingreso.</p>'}`,
  { onMount: r => {
    const rs = $('#u-reset', r); if (rs) rs.onclick = () => sendPasswordResetEmail(auth, u.email).then(() => toast('Correo enviado a ' + u.email)).catch(err => toast(errMsg(err), 'bad'));
    $('#fu', r).onsubmit = ev => { ev.preventDefault(); ocupado($('#u-save'), async () => {
      const nombre = val('u-n'), rol = val('u-r'), docu = val('u-d');
      if (!nombre) return toast('Escribe el nombre', 'bad');
      if (u) {
        const activo = $('#u-a').checked;
        if (u.id === fbUser.uid && (rol !== 'admin' || !activo)) return toast('No puedes quitarte a ti mismo el rol de administrador ni desactivarte', 'bad');
        if (u.id === C.ownerUid && (rol !== 'admin' || !activo)) return toast('El dueño de la droguería siempre es administrador activo', 'bad');
        await updateDoc(tdoc('members', u.id), { nombre, rol, activo, doc: docu });
      } else {
        const email = val('u-m'), pass = $('#u-p').value;
        if (pass.length < 6) return toast('La contraseña debe tener al menos 6 caracteres', 'bad');
        // Se crea la cuenta con una segunda conexión para no cerrar tu sesión.
        const app2 = getApps().find(a => a.name === 'altas') || initializeApp(firebaseConfig, 'altas');
        const auth2 = getAuth(app2);
        const cred = await createUserWithEmailAndPassword(auth2, email, pass);
        await signOut(auth2);
        await setDoc(tdoc('members', cred.user.uid), { uid: cred.user.uid, nombre, email, rol, activo: true, doc: docu });
      }
      closeModal(); toast('Usuario guardado');
    }); };
  } });
}

/* ---------- PANEL DE PLATAFORMA (solo el dueño de Mostrador) ---------- */
async function renderPlataforma() {
  renderCargando('Cargando droguerías…');
  try {
    const snap = await getDocs(collection(db, 'tenants'));
    const lista = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.creado?.toMillis?.() || 0) - (a.creado?.toMillis?.() || 0));
    const dias = t => Math.max(0, Math.ceil(((t.creado?.toMillis?.() || 0) + DIAS_PRUEBA * 86400000 - Date.now()) / 86400000));
    const chip = t => t.estado === 'activa' ? '<span class="pill ok">Activa</span>' : t.estado === 'suspendida' ? '<span class="pill bad">Suspendida</span>' : (dias(t) > 0 ? `<span class="pill warn">Prueba · ${dias(t)} días</span>` : '<span class="pill bad">Prueba vencida</span>');
    $('#app').innerHTML = `<main style="margin:0 auto;padding-inline:16px">
      <header class="ph"><div><p class="eyebrow">Mostrador · Plataforma</p><h1>Droguerías registradas</h1></div><div class="ph-act"><button class="btn" id="pl-back">Volver</button></div></header>
      <section class="kpis">${kpi('Droguerías', lista.length, 'registradas')}${kpi('Activas', lista.filter(t => t.estado === 'activa').length, 'pagando', 'ok')}${kpi('En prueba', lista.filter(t => t.estado === 'prueba' && dias(t) > 0).length, `${DIAS_PRUEBA} días gratis`)}${kpi('Suspendidas o vencidas', lista.filter(t => t.estado === 'suspendida' || (t.estado === 'prueba' && !dias(t))).length, 'sin acceso', 'warn')}</section>
      <section class="card flush"><div class="tbl"><table><thead><tr><th>Droguería</th><th>NIT</th><th>Ciudad</th><th>Registro</th><th>Estado</th><th></th></tr></thead><tbody>
      ${lista.map(t => `<tr><td><b>${esc(t.info?.nombre)}</b><span class="sub mono">${t.id}</span></td><td class="mono">${esc(t.info?.nit)}</td><td>${esc(t.info?.ciudad)}</td><td>${t.creado ? fDate(isoDate(t.creado.toDate())) : ''}</td><td>${chip(t)}</td>
        <td><div class="actions">${t.estado !== 'activa' ? `<button class="btn sm" data-est="activa" data-id="${t.id}">Activar</button>` : ''}${t.estado !== 'suspendida' ? `<button class="btn sm danger ghost" data-est="suspendida" data-id="${t.id}">Suspender</button>` : ''}</div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">Aún no hay droguerías.</td></tr>'}
      </tbody></table></div></section></main>`;
    $('#pl-back').onclick = renderSelector;
    $$('[data-est]').forEach(b => b.onclick = () => ocupado(b, async () => { await updateDoc(doc(db, 'tenants', b.dataset.id), { estado: b.dataset.est }); toast('Estado actualizado'); renderPlataforma(); }));
  } catch (e) { renderFallo(e); }
}

/* ---------- ARRANQUE ---------- */
if (!configurado) renderSinConfigurar();
