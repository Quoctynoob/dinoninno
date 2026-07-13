import { context, requestExpandedMode } from '@devvit/web/client';

const startButton = document.getElementById('start-button') as HTMLButtonElement;
startButton.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});

// Personal greeting under the dino
const greeting = document.getElementById('greeting') as HTMLParagraphElement;
greeting.textContent = context.username
  ? `The pack awaits, ${context.username}!`
  : 'The pack awaits!';