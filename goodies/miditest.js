const midi = require('midi');

// Créer une instance de sortie
const output = new midi.Output();

// Lister les ports disponibles pour trouver votre synthé
const portCount = output.getPortCount();
console.log(`Nombre de ports trouvés : ${portCount}`);

for (let i = 0; i < portCount; i++) 
{
  console.log(`${i}: ${output.getPortName(i)}`);
}

// Ouvrir le port (remplacez 0 par l'index de votre synthé listé ci-dessus)
if (portCount > 0) 
{
  output.openPort(2);

  // Envoyer les octets 0xF5 (245) et 0x03 (3)
  // La méthode sendMessage prend un tableau d'entiers
  output.sendMessage([0xF0, 0x42, 0x30, 0x42, 0x12, 0x01, 0xF7]);

  console.log("Message envoyé !");

  // Fermer le port proprement après un court délai
  setTimeout(() => {
    output.closePort();
  }, 100);
} else {
  console.log("Aucun périphérique MIDI détecté.");
}