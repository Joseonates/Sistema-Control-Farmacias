# Mostrador · versión en la nube (Firebase)

Sistema de control para droguerías: ventas, inventario por lote con semáforo de vencimientos, compras, caja, reportes y usuarios con roles. Es una plataforma: cada droguería se registra sola, tiene 30 días de prueba y tú (dueño de la plataforma) la activas o la suspendes.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Página principal |
| `app.js` | Toda la lógica de la aplicación (comentada por secciones) |
| `estilos.css` | Diseño |
| `firebase-config.js` | **Aquí pegas la configuración de tu proyecto** y los datos de soporte |
| `firestore.rules` | Reglas de seguridad (quién puede leer y escribir qué) |
| `firestore.indexes.json` | Índice que necesita el inicio de sesión |
| `firebase.json`, `package.json` | Para publicar reglas y correr las pruebas desde la terminal |
| `test/reglas.test.js` | 31 pruebas automáticas de las reglas de seguridad |

## Paso 1. Crear el proyecto de Firebase

Usa un proyecto **nuevo**, separado de HVAC 360.

1. En https://console.firebase.google.com crea el proyecto, por ejemplo `mostrador-droguerias`. Google Analytics no es necesario.
2. **Firestore Database** > Crear base de datos > edición **Standard** > modo **producción** > ubicación `us-east1` (la misma de HVAC 360; no se puede cambiar después).
3. **Authentication** > Comenzar > método **Correo electrónico/contraseña** > Habilitar.
4. **Authentication** > Configuración > Dominios autorizados > agrega `joseonates.github.io`.
5. **Configuración del proyecto** (engranaje) > Tus apps > ícono web `</>` > registra la app `Mostrador` (sin Hosting). Copia el objeto `firebaseConfig` y pégalo en `firebase-config.js`. Llena también `soporte` con tu teléfono o correo.

## Paso 2. Publicar las reglas y el índice

**Opción fácil (consola):**

1. Firestore > **Reglas**: borra lo que hay, pega todo el contenido de `firestore.rules` y pulsa **Publicar**.
2. Firestore > **Índices** > **Exenciones de un solo campo** > Agregar exención:
   - ID de la colección: `members`
   - Ruta del campo: `uid`
   - Activa **Ascendente** para *Colección* y para *Grupo de colecciones*.

   Si lo olvidas, al iniciar sesión aparece un error con un enlace que crea el índice directamente.

**Opción terminal** (si tienes Node.js instalado), en la carpeta del proyecto:

```
npm install
npx firebase login
npx firebase use --add        (elige tu proyecto)
npm run publicar-reglas
```

## Paso 3. Subir a GitHub Pages

1. Crea un repositorio, por ejemplo `Mostrador`.
2. Sube `index.html`, `app.js`, `estilos.css` y `firebase-config.js`. Los demás archivos pueden ir también; no afectan la página. **No subas** la carpeta `node_modules`.
3. Settings > Pages > Deploy from a branch > `main` / root.
4. La app queda en `https://joseonates.github.io/Mostrador/`.

## Paso 4. Tu primera droguería y tu acceso de plataforma

1. Abre la app > **Registrar mi droguería**. Tú quedas como administrador.
2. En Productos pulsa **Cargar catálogo de ejemplo**, crea un proveedor, registra una compra, abre la caja y haz una venta.
3. Para ver el **panel de plataforma** (lista de todas las droguerías, activar y suspender):
   - Authentication > Usuarios > copia tu **UID**.
   - Firestore > Iniciar colección `superadmins` > ID del documento = tu UID > campo `nombre` (texto) = tu nombre.
   - Sal y vuelve a entrar: aparece el botón **Panel de plataforma** al elegir droguería.

## Cómo funciona la seguridad

- Cada droguería vive en `tenants/{id}` y **nadie de otra droguería puede leer ni escribir sus datos**.
- El rol de cada persona está en `tenants/{id}/members/{uid}`: `admin`, `regente` o `vendedor`.
- **Vendedor:** vende, abre y cierra caja, consulta inventario. No crea productos, no registra compras ni bajas, no anula ventas, no dispensa control especial.
- **Regente:** todo lo anterior más catálogo, compras, proveedores, bajas, anulaciones y reportes.
- **Administrador:** todo, más datos de la droguería, reglas del semáforo y usuarios.
- Las reglas en la nube también verifican que:
  - el consecutivo de ventas suba de uno en uno, sin saltos ni repetidos;
  - solo haya una caja abierta por droguería y que no se venda con la caja cerrada;
  - un vendedor solo pueda descontar existencias dentro de una venta real;
  - una droguería suspendida, o con la prueba de 30 días vencida, no pueda operar. Sus datos no se borran.
- Ventas, compras, bajas y anulaciones se guardan en **transacciones**: si dos equipos venden el mismo lote al mismo tiempo, Firestore reintenta con los datos frescos y nunca quedan existencias negativas.

## Modelo de datos

```
superadmins/{uid}                  dueños de la plataforma (se crea a mano)
tenants/{droguería}                info, config, ownerUid, estado (prueba | activa | suspendida), creado
  members/{uid}                    uid, nombre, email, rol, activo, doc
  productos/{id}                   codigo, nombre, principio, concentracion, forma, lab, invima,
                                   tipo (libre | formula | control), fracc, upc, precioCaja, precioUnidad,
                                   iva (0 | 5 | 19), stockMin, ubicacion
  lotes/{id}                       pid, lote, vence, cant (unidades mínimas), costoU, compraId, ingreso
  proveedores/{id}                 nombre, nit, ciudad, contacto, telefono, correo
  compras/{id}                     fecha, provId, factura, lineas[], total, userId
  ventas/{id}                      consecutivo, numero, fecha, dia, cajaId, items[] (con lotes usados),
                                   total, base, iva, costo, pagos[], formula, anulada
  bajas/{id}                       fecha, dia, pid, loteId, lote, cant, costo, motivo, obs, userId
  cajas/{id}                       apertura, dia, base, userId, cierre{contado, esperado, dif, ...}
  contadores/ventas                n (último consecutivo)
  estado/caja                      abiertaId (caja abierta o null)
```

## Pruebas de las reglas

Requieren Node.js 20 o superior y Java 11 o superior en tu computador:

```
npm install
npm test
```

Arranca el emulador de Firestore y corre las 31 pruebas: aislamiento entre droguerías, roles, consecutivo, caja única, droguería suspendida y prueba vencida.

## Plan gratuito (Spark): hasta dónde alcanza

- Límites diarios compartidos por **todas** las droguerías del proyecto: 50.000 lecturas, 20.000 escrituras, 1 GiB guardado.
- Cada vez que un equipo abre la app lee el catálogo, los lotes con existencias y las ventas de los últimos 35 días. Una droguería con 1.500 productos gasta unas 4.000 a 5.000 lecturas por equipo al día.
- El plan gratuito sirve para el piloto con 1 o 2 droguerías. Para vender a más droguerías hay que pasar al plan Blaze (pago por uso). Con ese consumo, el costo por droguería es de centavos de dólar al mes.

## Limitaciones de esta versión

- **Sin internet no se puede vender.** La app muestra los datos guardados en el equipo, pero las ventas necesitan conexión para descontar el inventario sin errores. Vender sin conexión es una mejora futura.
- Los reportes cubren los últimos 35 días.
- El comprobante es interno. La factura electrónica DIAN llega en la Fase 2.
- La regla de "control especial solo lo vende el regente" se verifica en la app, no en la nube.
- Si el correo de un empleado ya tiene cuenta en Mostrador (por ejemplo, trabaja en otra droguería de la plataforma), no se puede crear desde **Nuevo usuario**. Por ahora se agrega a mano en Firestore.
