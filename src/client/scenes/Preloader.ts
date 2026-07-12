import { Scene } from 'phaser';

export class Preloader extends Scene {
  constructor() {
    super('Preloader');
  }

  init() {
    //  We loaded this image in our Boot Scene, so we can display it here
    this.add.image(512, 384, 'background');

    //  A simple progress bar. This is the outline of the bar.
    this.add.rectangle(512, 384, 468, 32).setStrokeStyle(1, 0xffffff);

    //  This is the progress bar itself. It will increase in size from the left based on the % of progress.
    const bar = this.add.rectangle(512 - 230, 384, 4, 28, 0xffffff);

    //  Use the 'progress' event emitted by the LoaderPlugin to update the loading bar
    this.load.on('progress', (progress: number) => {
      //  Update the progress bar (our bar is 464px wide, so 100% = 464px)
      bar.width = 4 + 460 * progress;
    });
  }

  preload() {

    this.load.setPath('../assets');
    this.load.image('shadow', 'shadow.png');
    // ---- Dino party sprites (24x24 frames, 24-frame sheets) ----
    this.load.spritesheet('dino_attacker', 'dino_attacker.png', {
      frameWidth: 24, frameHeight: 24,
    });
    this.load.spritesheet('dino_defender', 'dino_defender.png', {
      frameWidth: 24, frameHeight: 24,
    });
    this.load.spritesheet('dino_supporter', 'dino_supporter.png', {
      frameWidth: 24, frameHeight: 24,
    });

    this.load.image('boss_volcano', 'assets/boss_volcano.png');
    this.load.image('bg_arena', 'assets/bg_arena.png');
  }

  create() {
    //  When all the assets have loaded, it's often worth creating global objects here that the rest of the game can use.
    //  For example, you can define global animations here, so we can use them in other scenes.

    //  Move to the MainMenu. You could also swap this for a Scene Transition, such as a camera fade.
    // ---- Dino animations (Arks sheet layout: 0-3 idle, 4-9 run, 10-12 kick, 13-16 hurt) ----
    for (const key of ['dino_attacker', 'dino_defender', 'dino_supporter']) {
      this.anims.create({
        key: `${key}_idle`,
        frames: this.anims.generateFrameNumbers(key, { start: 0, end: 3 }),
        frameRate: 6,
        repeat: -1, // loop forever
      });
      this.anims.create({
        key: `${key}_attack`,
        frames: this.anims.generateFrameNumbers(key, { start: 10, end: 12 }),
        frameRate: 12,
        repeat: 0, // play once
      });
      this.anims.create({
        key: `${key}_hurt`,
        frames: this.anims.generateFrameNumbers(key, { start: 13, end: 16 }),
        frameRate: 10,
        repeat: 0,
      });
    }

    //  All assets loaded + animations defined -> off to the main menu
    this.scene.start('MainMenu');
  }
}
