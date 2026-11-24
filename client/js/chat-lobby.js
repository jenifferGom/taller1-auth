// Chat en el lobby del jugador: une el panel de js/chat.js con la conexión de lobby.js.
// lobby.js guarda en window.guaroChatPendientes lo que llegue antes de que este módulo cargue.
// Cuando el jugador entra a una sala (sala_estado), el panel muestra la pestaña "Partida" con el chat
// independiente de esa sala; al salir, la pestaña desaparece.
import { montarChat } from './chat.js';

const chat = montarChat({
  modo: 'jugador',
  enviar: (obj) => !!(window.enviarAlServidor && window.enviarAlServidor(obj)),
  miUsuario: () => window.miUsuario || null,
});
const ultimaSala = window.guaroUltimos && window.guaroUltimos.sala_estado;
if (ultimaSala && ultimaSala.sala) chat.cambiarSala(ultimaSala.sala.codigo);
for (const msg of window.guaroChatPendientes || []) chat.recibir(msg);
window.guaroChatPendientes = null;
window.addEventListener('guaro:chat', (e) => chat.recibir(e.detail));
window.addEventListener('guaro:mensaje', (e) => {
  const m = e.detail;
  if (m.type === 'sala_estado') chat.cambiarSala(m.sala && m.sala.estado !== 'cerrada' ? m.sala.codigo : null);
  if (m.type === 'welcome') {                                   // reconexión (otro coordinador): vuelve a pedir el de la sala
    const s = window.guaroSalas && window.guaroSalas.sala();
    if (s) window.enviarAlServidor && window.enviarAlServidor({ type: 'chat_historial_pedir', canal: `sala:${s.codigo}` });
  }
});
