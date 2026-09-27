// =====================================================================
// Configuración de Firebase de Mostrador
// Pega aquí los datos de tu proyecto:
// Consola de Firebase > Configuración del proyecto > Tus apps > App web
// Estos datos no son secretos: la seguridad la dan las reglas de Firestore.
// =====================================================================
export const firebaseConfig = {
  apiKey: "AIzaSyDVqoW8BRMqJfBHZLNVZ7E7maC8uzhC-Tg",
  authDomain: "sistema-control-farmacias.firebaseapp.com",
  projectId: "sistema-control-farmacias",
  storageBucket: "sistema-control-farmacias.firebasestorage.app",
  messagingSenderId: "624642253369",
  appId: "1:624642253369:web:0e2d8fbb131ae84758e3e8"
};

// Datos que ven las droguerías suspendidas o con la prueba vencida.
export const soporte = {
  nombre: 'Soporte Mostrador',
  telefono: '3228909446',
  correo: 'joseonates@gmail.com',
};
