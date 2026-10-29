/*  CS42 Week 11 - Assignment 13: Enemy AI + Finite State Machines
    ---------------------------------------------------------------
    GAME: CORE HEIST
    You are a small thief-drone. Collect every energy core in the vault
    while the security guards patrol the halls. Guards are NPCs controlled
    entirely by a finite state machine written with JavaScript switch()
    statements.

    GUARD STATES (see updateGuard() and changeState()):
      PATROL   walk a loop of waypoints
      ALERT    spotted something - freeze, turn to face it, show "!"
      CHASE    run straight at the player
      SEARCH   go to where the player was last seen, then scan the area
      STUNNED  hit by the player's EMP pulse - frozen for a few seconds

    TRANSITIONS
      PATROL  -> ALERT    guard sees the player
      ALERT   -> CHASE    still sees the player when the alert timer ends
      ALERT   -> SEARCH   lost the player during the alert
      CHASE   -> SEARCH   lost line of sight for a moment
      SEARCH  -> ALERT    sees the player again
      SEARCH  -> PATROL   finished scanning (or could not reach the spot)
      ANY     -> STUNNED  player fires an EMP pulse nearby
      STUNNED -> SEARCH   stun wears off

    INPUT (keyboard OR pointer)
      WASD / Arrow keys ..... move
      Hold left mouse ....... move toward the pointer
      SHIFT ................. sneak (slower, but guards see much less)
      SPACE / right click ... EMP pulse (stuns nearby guards, has a cooldown)
      R (or click) .......... restart after the game ends
*/

// ---------------------------------------------------------------------
// GAME WORLD DIMENSIONS
// The world is bigger than the screen; the camera follows the player.
// ---------------------------------------------------------------------
const WORLD_W = 1600;   // world width in pixels
const WORLD_H = 1200;   // world height in pixels
const VIEW_W = 960;     // canvas (camera) width
const VIEW_H = 640;     // canvas (camera) height

// ---------------------------------------------------------------------
// TUNING VALUES
// ---------------------------------------------------------------------
const CFG = {
    playerSpeed: 220,
    sneakSpeed: 110,
    playerRadius: 12,
    guardRadius: 14,
    lives: 3,

    patrolSpeed: 90,
    searchSpeed: 130,
    chaseSpeed: 175,
    turnRate: 6,                       // radians per second a guard can turn

    visionRange: 270,                  // how far a guard sees
    sneakVisionScale: 0.5,             // vision multiplier while the player sneaks
    fov: Phaser.Math.DegToRad(75),     // width of the vision cone
    hearRange: 55,                     // guards notice you this close, any angle
    hearRangeSneak: 28,

    alertTime: 0.6,                    // seconds spent in ALERT
    loseSightTime: 0.5,                // seconds of grace before CHASE gives up
    searchTime: 3.0,                   // seconds scanning once at the last-known spot
    searchTimeout: 7.0,                // give up walking to the last-known spot
    stunTime: 3.5,                     // seconds a guard stays STUNNED

    empRadius: 230,
    empCooldown: 5000,                 // ms
    invulnTime: 2000                   // ms of safety after being caught
};

// Guard FSM state names. Using an object means the switch() cases below
// can't be mistyped without an obvious error.
const GS = {
    PATROL: 'PATROL',
    ALERT: 'ALERT',
    CHASE: 'CHASE',
    SEARCH: 'SEARCH',
    STUNNED: 'STUNNED'
};

// Each state gets its own colour so the AI is easy to read on screen.
const STATE_COLOR = {
    PATROL: 0x4cd964,
    ALERT: 0xffe14a,
    CHASE: 0xff3b3b,
    SEARCH: 0xff9f1a,
    STUNNED: 0x5aa9ff
};

// ---------------------------------------------------------------------
// LEVEL DATA
// ---------------------------------------------------------------------
const START = { x: 800, y: 760 };

// Walls are axis-aligned rectangles (center x, center y, width, height).
const WALLS = [
    { x: 400,  y: 300,  w: 200, h: 30  },
    { x: 1000, y: 310,  w: 30,  h: 250 },
    { x: 700,  y: 600,  w: 300, h: 30  },
    { x: 300,  y: 800,  w: 30,  h: 250 },
    { x: 1200, y: 850,  w: 260, h: 30  },
    { x: 850,  y: 1000, w: 30,  h: 200 },
    { x: 1310, y: 420,  w: 120, h: 30  }
];

const CORES = [
    [100, 100], [700, 120], [1550, 100], [1310, 520],
    [880, 420], [1500, 820], [1150, 1100], [700, 1120],
    [100, 1120], [500, 880], [120, 780], [1000, 560]
];

// Each guard loops through its route of waypoints.
const GUARD_DEFS = [
    { route: [[200, 150], [800, 150], [800, 450], [200, 450]] },
    { route: [[1200, 150], [1450, 150], [1450, 600], [1200, 600]] },
    { route: [[150, 560], [150, 1050], [450, 1050], [450, 700]] },
    { route: [[1000, 1000], [1450, 1000], [1450, 700], [1000, 700]] },
    { route: [[650, 350], [900, 350], [900, 500], [650, 500]] }
];

// ---------------------------------------------------------------------
// GEOMETRY HELPERS (pure functions, no Phaser needed)
// ---------------------------------------------------------------------

// Wrap an angle into the range -PI..PI.
function wrapAngle(a) {
    return Math.atan2(Math.sin(a), Math.cos(a));
}

// Distance along a ray (origin ox,oy; unit direction dx,dy) to the point
// where it enters an axis-aligned box, or Infinity if it never does.
function rayBoxDistance(ox, oy, dx, dy, b) {
    let tmin = -Infinity;
    let tmax = Infinity;

    if (Math.abs(dx) < 1e-9) {
        if (ox < b.x1 || ox > b.x2) { return Infinity; }
    } else {
        const t1 = (b.x1 - ox) / dx;
        const t2 = (b.x2 - ox) / dx;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    }

    if (Math.abs(dy) < 1e-9) {
        if (oy < b.y1 || oy > b.y2) { return Infinity; }
    } else {
        const t1 = (b.y1 - oy) / dy;
        const t2 = (b.y2 - oy) / dy;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    }

    if (tmax < 0 || tmin > tmax) { return Infinity; }
    return tmin < 0 ? 0 : tmin;
}

// ---------------------------------------------------------------------
// THE GAME SCENE
// ---------------------------------------------------------------------
class HeistScene extends Phaser.Scene {

    constructor() {
        super('heist');
    }

    // ------------------------------------------------------------ create
    create() {
        this.mode = 'playing';          // 'playing' | 'won' | 'lost'
        this.lives = CFG.lives;
        this.coreCount = 0;
        this.elapsed = 0;
        this.empReadyAt = 0;
        this.emp = null;
        this.invulnUntil = 0;
        this.sneaking = false;
        this.endedAt = 0;

        // World + camera bounds
        this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H);
        this.cameras.main.setBounds(0, 0, WORLD_W, WORLD_H);
        this.cameras.main.setBackgroundColor(0x080b12);

        this.drawFloor();
        this.buildWalls();
        this.buildCores();
        this.buildPlayer();
        this.buildGuards();
        this.buildHud();
        this.buildInput();

        // Layers that are redrawn every frame
        this.coneGfx.setDepth(5);
        this.fxGfx.setDepth(20);
    }

    // ------------------------------------------------------- level build
    drawFloor() {
        const g = this.add.graphics().setDepth(0);
        g.fillStyle(0x10151f, 1);
        g.fillRect(0, 0, WORLD_W, WORLD_H);
        g.lineStyle(1, 0x1a2332, 1);
        for (let x = 0; x <= WORLD_W; x += 100) { g.lineBetween(x, 0, x, WORLD_H); }
        for (let y = 0; y <= WORLD_H; y += 100) { g.lineBetween(0, y, WORLD_W, y); }
        g.lineStyle(6, 0x3a4a6b, 1);
        g.strokeRect(0, 0, WORLD_W, WORLD_H);

        // Safe-zone marker where the player (re)spawns
        g.lineStyle(2, 0x4de1ff, 0.35);
        g.strokeCircle(START.x, START.y, 34);

        this.coneGfx = this.add.graphics();
        this.fxGfx = this.add.graphics();
    }

    buildWalls() {
        this.wallObjs = [];
        this.wallBoxes = [];
        WALLS.forEach(w => {
            const r = this.add.rectangle(w.x, w.y, w.w, w.h, 0x39465e)
                .setStrokeStyle(2, 0x7f93bd)
                .setDepth(3);
            this.physics.add.existing(r, true);   // true = static body
            this.wallObjs.push(r);
            this.wallBoxes.push({
                x1: w.x - w.w / 2, y1: w.y - w.h / 2,
                x2: w.x + w.w / 2, y2: w.y + w.h / 2
            });
        });
    }

    buildCores() {
        this.cores = CORES.map(c => {
            const o = this.add.rectangle(c[0], c[1], 14, 14, 0xffd84a)
                .setAngle(45)
                .setStrokeStyle(2, 0xfff2b0)
                .setDepth(4);
            this.tweens.add({
                targets: o, scale: 1.3, yoyo: true, repeat: -1,
                duration: 650, ease: 'Sine.easeInOut'
            });
            return o;
        });
    }

    buildPlayer() {
        this.player = this.add.circle(START.x, START.y, CFG.playerRadius, 0x4de1ff)
            .setStrokeStyle(2, 0xffffff)
            .setDepth(10);
        this.physics.add.existing(this.player);
        this.player.body.setCircle(CFG.playerRadius);
        this.player.body.setCollideWorldBounds(true);
        this.physics.add.collider(this.player, this.wallObjs);

        this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
        this.invulnUntil = this.time.now + CFG.invulnTime;
    }

    buildGuards() {
        this.guards = GUARD_DEFS.map((def, i) => {
            const start = def.route[0];
            const next = def.route[1];
            const body = this.add.circle(start[0], start[1], CFG.guardRadius, STATE_COLOR.PATROL)
                .setStrokeStyle(3, 0x0b0f16)
                .setDepth(8);
            this.physics.add.existing(body);
            body.body.setCircle(CFG.guardRadius);
            body.body.setCollideWorldBounds(true);

            const label = this.add.text(start[0], start[1] - 28, 'PATROL', {
                fontFamily: 'monospace', fontSize: '11px', color: '#ffffff',
                backgroundColor: '#000000aa', padding: { x: 3, y: 1 }
            }).setOrigin(0.5).setDepth(9);

            const guard = {
                id: i,
                obj: body,
                label: label,
                route: def.route,
                wp: 1,                                   // index of next waypoint
                heading: Math.atan2(next[1] - start[1], next[0] - start[0]),
                state: null,
                stateTime: 0,
                lastKnown: { x: start[0], y: start[1] },
                lostSight: 0,
                searchArrived: false,
                scanBase: 0
            };
            this.changeState(guard, GS.PATROL);
            guard.wp = 1;
            return guard;
        });

        this.physics.add.collider(this.guards.map(g => g.obj), this.wallObjs);
    }

    buildHud() {
        const style = { fontFamily: 'monospace', fontSize: '18px', color: '#e8f1ff' };
        this.hudText = this.add.text(14, 10, '', style).setScrollFactor(0).setDepth(100);

        this.empText = this.add.text(VIEW_W - 14, 34, '', {
            fontFamily: 'monospace', fontSize: '13px', color: '#9fe8ff'
        }).setOrigin(1, 0).setScrollFactor(0).setDepth(100);

        this.helpText = this.add.text(14, VIEW_H - 14,
            'WASD/Arrows or hold Left Mouse: move   |   SHIFT: sneak (guards see less)\n' +
            'SPACE or Right Click: EMP pulse - stuns nearby guards', {
                fontFamily: 'monospace', fontSize: '12px', color: '#8fa3c7'
            }).setOrigin(0, 1).setScrollFactor(0).setDepth(100);

        this.hudGfx = this.add.graphics().setScrollFactor(0).setDepth(99);

        // Intro banner that fades out
        this.intro = this.add.text(VIEW_W / 2, VIEW_H / 2 - 120,
            'CORE HEIST\nCollect all ' + CORES.length + ' cores. Avoid the guards.', {
                fontFamily: 'monospace', fontSize: '24px', color: '#ffffff',
                align: 'center', backgroundColor: '#000000aa', padding: { x: 14, y: 10 }
            }).setOrigin(0.5).setScrollFactor(0).setDepth(110);
        this.tweens.add({
            targets: this.intro, alpha: 0, delay: 3500, duration: 800
        });

        // End-of-game overlay (hidden until needed)
        this.endText = this.add.text(VIEW_W / 2, VIEW_H / 2, '', {
            fontFamily: 'monospace', fontSize: '30px', color: '#ffffff',
            align: 'center', backgroundColor: '#000000dd', padding: { x: 24, y: 18 }
        }).setOrigin(0.5).setScrollFactor(0).setDepth(120).setVisible(false);
    }

    buildInput() {
        this.keys = this.input.keyboard.addKeys({
            up: 'W', down: 'S', left: 'A', right: 'D',
            up2: 'UP', down2: 'DOWN', left2: 'LEFT', right2: 'RIGHT',
            shift: 'SHIFT', space: 'SPACE', restart: 'R'
        });

        // Right click fires the EMP, so stop the browser context menu.
        if (this.input.mouse) { this.input.mouse.disableContextMenu(); }

        this.input.on('pointerdown', (pointer) => {
            if (this.mode !== 'playing') {
                if (this.time.now - this.endedAt > 600) { this.scene.restart(); }
                return;
            }
            if (pointer.rightButtonDown()) { this.fireEmp(); }
        });
    }

    // ------------------------------------------------------------ update
    update(time, delta) {
        const dt = Math.min(delta, 50) / 1000;   // seconds, clamped for tab-switches

        if (this.mode === 'playing') {
            this.elapsed += dt;
            this.updatePlayer(time);
            this.guards.forEach(g => this.updateGuard(g, dt));
            this.checkCores();
            this.checkCaught(time);
        } else {
            this.player.body.setVelocity(0, 0);
            this.guards.forEach(g => g.obj.body.setVelocity(0, 0));
            if (Phaser.Input.Keyboard.JustDown(this.keys.restart)) { this.scene.restart(); }
        }

        this.guards.forEach(g => {
            g.label.setPosition(g.obj.x, g.obj.y - 28);
        });
        this.drawCones();
        this.drawFx(time);
        this.drawHud(time);
    }

    // ----------------------------------------------------------- player
    updatePlayer(time) {
        const k = this.keys;
        let vx = 0;
        let vy = 0;
        if (k.left.isDown || k.left2.isDown) { vx -= 1; }
        if (k.right.isDown || k.right2.isDown) { vx += 1; }
        if (k.up.isDown || k.up2.isDown) { vy -= 1; }
        if (k.down.isDown || k.down2.isDown) { vy += 1; }

        // Pointer movement: hold left button and the player heads toward it.
        if (vx === 0 && vy === 0) {
            const p = this.input.activePointer;
            if (p.isDown && !p.rightButtonDown()) {
                const cam = this.cameras.main;
                const wx = cam.scrollX + p.x;
                const wy = cam.scrollY + p.y;
                const dx = wx - this.player.x;
                const dy = wy - this.player.y;
                const d = Math.hypot(dx, dy);
                if (d > 10) { vx = dx / d; vy = dy / d; }
            }
        }

        const len = Math.hypot(vx, vy);
        if (len > 0) { vx /= len; vy /= len; }

        this.sneaking = k.shift.isDown;
        const speed = this.sneaking ? CFG.sneakSpeed : CFG.playerSpeed;
        this.player.body.setVelocity(vx * speed, vy * speed);

        // Sneaking = darker, invulnerable = flickering
        if (time < this.invulnUntil) {
            this.player.setAlpha(Math.floor(time / 90) % 2 ? 0.35 : 1);
        } else {
            this.player.setAlpha(this.sneaking ? 0.6 : 1);
        }

        if (Phaser.Input.Keyboard.JustDown(k.space)) { this.fireEmp(); }
    }

    fireEmp() {
        const now = this.time.now;
        if (now < this.empReadyAt) { return; }
        this.empReadyAt = now + CFG.empCooldown;
        this.emp = { x: this.player.x, y: this.player.y, start: now, dur: 500 };

        // Any guard inside the pulse radius is forced into STUNNED.
        this.guards.forEach(g => {
            const d = Math.hypot(g.obj.x - this.player.x, g.obj.y - this.player.y);
            if (d <= CFG.empRadius) { this.changeState(g, GS.STUNNED); }
        });
    }

    checkCores() {
        for (let i = this.cores.length - 1; i >= 0; i--) {
            const c = this.cores[i];
            if (Math.hypot(c.x - this.player.x, c.y - this.player.y) < CFG.playerRadius + 12) {
                this.popText(c.x, c.y - 10, '+1', '#ffd84a', 20);
                c.destroy();
                this.cores.splice(i, 1);
                this.coreCount++;
            }
        }
        if (this.cores.length === 0) { this.endGame('won'); }
    }

    checkCaught(time) {
        if (time < this.invulnUntil) { return; }
        for (const g of this.guards) {
            if (g.state === GS.STUNNED) { continue; }
            const d = Math.hypot(g.obj.x - this.player.x, g.obj.y - this.player.y);
            if (d < CFG.guardRadius + CFG.playerRadius) {
                this.lives--;
                this.cameras.main.shake(220, 0.012);
                this.cameras.main.flash(180, 255, 60, 60);
                if (this.lives <= 0) {
                    this.endGame('lost');
                } else {
                    // Back to the safe zone; every guard calms down to PATROL.
                    this.player.body.reset(START.x, START.y);
                    this.invulnUntil = time + CFG.invulnTime;
                    this.guards.forEach(other => this.changeState(other, GS.PATROL));
                }
                return;
            }
        }
    }

    endGame(result) {
        this.mode = result;
        this.endedAt = this.time.now;
        this.player.setAlpha(1);
        const t = this.elapsed.toFixed(1);
        if (result === 'won') {
            this.endText.setText('VAULT CLEARED!\nAll cores stolen in ' + t + 's\n\nPress R or click to play again');
        } else {
            this.endText.setText('CAUGHT!\nCores collected: ' + this.coreCount + '/' + CORES.length +
                '\n\nPress R or click to try again');
        }
        this.endText.setVisible(true);
    }

    // ======================================================================
    //  GUARD FINITE STATE MACHINE
    // ======================================================================

    // Runs once whenever a guard ENTERS a new state. Entry actions live
    // here so they happen exactly one time per transition.
    changeState(g, newState) {
        g.state = newState;
        g.stateTime = 0;

        switch (newState) {
            case GS.PATROL:
                // Resume the route from whichever waypoint is closest.
                g.wp = this.nearestWaypoint(g);
                break;

            case GS.ALERT:
                g.obj.body.setVelocity(0, 0);
                this.popText(g.obj.x, g.obj.y - 44, '!', '#ffe14a', 28);
                break;

            case GS.CHASE:
                g.lostSight = 0;
                break;

            case GS.SEARCH:
                g.searchArrived = false;
                g.scanBase = g.heading;
                break;

            case GS.STUNNED:
                g.obj.body.setVelocity(0, 0);
                this.popText(g.obj.x, g.obj.y - 44, 'ZZZ', '#5aa9ff', 18);
                break;

            default:
                break;
        }

        g.obj.setFillStyle(STATE_COLOR[newState]);
        g.label.setText(newState);
    }

    // Runs every frame for every guard: what does this state DO?
    updateGuard(g, dt) {
        g.stateTime += dt;
        const p = this.player;
        const sees = this.guardSeesPlayer(g);

        switch (g.state) {

            case GS.PATROL: {
                const wp = g.route[g.wp];
                const d = this.steer(g, wp[0], wp[1], CFG.patrolSpeed, dt);
                if (d < 8) { g.wp = (g.wp + 1) % g.route.length; }
                if (sees) { this.changeState(g, GS.ALERT); }
                break;
            }

            case GS.ALERT: {
                g.obj.body.setVelocity(0, 0);
                if (sees) {
                    g.lastKnown = { x: p.x, y: p.y };
                    this.turnToward(g, Math.atan2(p.y - g.obj.y, p.x - g.obj.x), dt);
                }
                if (g.stateTime >= CFG.alertTime) {
                    this.changeState(g, sees ? GS.CHASE : GS.SEARCH);
                }
                break;
            }

            case GS.CHASE: {
                this.steer(g, p.x, p.y, CFG.chaseSpeed, dt);
                if (sees) {
                    g.lostSight = 0;
                    g.lastKnown = { x: p.x, y: p.y };
                } else {
                    g.lostSight += dt;
                    if (g.lostSight >= CFG.loseSightTime) { this.changeState(g, GS.SEARCH); }
                }
                break;
            }

            case GS.SEARCH: {
                if (!g.searchArrived) {
                    // Phase 1: walk to the last place the player was seen.
                    const d = this.steer(g, g.lastKnown.x, g.lastKnown.y, CFG.searchSpeed, dt);
                    if (d < 10) {
                        g.searchArrived = true;
                        g.stateTime = 0;
                        g.scanBase = g.heading;
                        g.obj.body.setVelocity(0, 0);
                    } else if (g.stateTime >= CFG.searchTimeout) {
                        this.changeState(g, GS.PATROL);     // couldn't get there
                        break;
                    }
                } else {
                    // Phase 2: stand still and sweep the vision cone side to side.
                    g.obj.body.setVelocity(0, 0);
                    g.heading = g.scanBase + Math.sin(g.stateTime * 2.4) * 1.5;
                    if (g.stateTime >= CFG.searchTime) {
                        this.changeState(g, GS.PATROL);
                        break;
                    }
                }
                if (sees) { this.changeState(g, GS.ALERT); }
                break;
            }

            case GS.STUNNED: {
                g.obj.body.setVelocity(0, 0);
                g.label.setAlpha(Math.floor(g.stateTime * 8) % 2 ? 0.4 : 1);
                if (g.stateTime >= CFG.stunTime) {
                    g.label.setAlpha(1);
                    g.lastKnown = { x: g.obj.x, y: g.obj.y };
                    this.changeState(g, GS.SEARCH);
                }
                break;
            }

            default:
                break;
        }
    }

    // ---------------------------------------------------- guard helpers
    nearestWaypoint(g) {
        let best = 0;
        let bestD = Infinity;
        g.route.forEach((w, i) => {
            const d = Math.hypot(w[0] - g.obj.x, w[1] - g.obj.y);
            if (d < bestD) { bestD = d; best = i; }
        });
        return best;
    }

    // Move toward a point at a given speed, turning the heading smoothly.
    // Returns the remaining distance.
    steer(g, tx, ty, speed, dt) {
        const dx = tx - g.obj.x;
        const dy = ty - g.obj.y;
        const d = Math.hypot(dx, dy);
        if (d > 1) {
            g.obj.body.setVelocity((dx / d) * speed, (dy / d) * speed);
            this.turnToward(g, Math.atan2(dy, dx), dt);
        } else {
            g.obj.body.setVelocity(0, 0);
        }
        return d;
    }

    turnToward(g, targetAngle, dt) {
        const diff = wrapAngle(targetAngle - g.heading);
        const step = CFG.turnRate * dt;
        g.heading = wrapAngle(g.heading + Math.max(-step, Math.min(step, diff)));
    }

    currentVisionRange() {
        return this.sneaking ? CFG.visionRange * CFG.sneakVisionScale : CFG.visionRange;
    }

    // Distance to the nearest wall along a ray (capped at maxDist).
    castRay(ox, oy, angle, maxDist) {
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        let best = maxDist;
        for (const b of this.wallBoxes) {
            const t = rayBoxDistance(ox, oy, dx, dy, b);
            if (t < best) { best = t; }
        }
        return best;
    }

    // Can the guard see the player? Needs: in range, inside the cone (or
    // very close), and no wall in between.
    guardSeesPlayer(g) {
        const dx = this.player.x - g.obj.x;
        const dy = this.player.y - g.obj.y;
        const d = Math.hypot(dx, dy);
        if (d > this.currentVisionRange()) { return false; }

        const hear = this.sneaking ? CFG.hearRangeSneak : CFG.hearRange;
        if (d > hear) {
            const diff = Math.abs(wrapAngle(Math.atan2(dy, dx) - g.heading));
            if (diff > CFG.fov / 2) { return false; }
        }
        return this.castRay(g.obj.x, g.obj.y, Math.atan2(dy, dx), d) >= d;
    }

    // ------------------------------------------------------------ visuals
    popText(x, y, str, color, size) {
        const t = this.add.text(x, y, str, {
            fontFamily: 'monospace', fontSize: size + 'px', color: color,
            stroke: '#000000', strokeThickness: 4
        }).setOrigin(0.5).setDepth(30);
        this.tweens.add({
            targets: t, y: y - 30, alpha: 0, duration: 700,
            onComplete: () => t.destroy()
        });
    }

    // Vision cones are clipped by walls using the same ray-casting the AI uses.
    drawCones() {
        const g = this.coneGfx;
        g.clear();
        const range = this.currentVisionRange();
        const steps = 16;

        this.guards.forEach(guard => {
            if (guard.state === GS.STUNNED) { return; }
            const color = STATE_COLOR[guard.state];
            const ox = guard.obj.x;
            const oy = guard.obj.y;

            g.fillStyle(color, guard.state === GS.CHASE ? 0.30 : 0.18);
            g.beginPath();
            g.moveTo(ox, oy);
            for (let i = 0; i <= steps; i++) {
                const a = guard.heading - CFG.fov / 2 + (CFG.fov * i) / steps;
                const dist = this.castRay(ox, oy, a, range);
                g.lineTo(ox + Math.cos(a) * dist, oy + Math.sin(a) * dist);
            }
            g.closePath();
            g.fillPath();

            // little "nose" showing where the guard is facing
            g.lineStyle(3, 0xffffff, 0.9);
            g.lineBetween(ox, oy,
                ox + Math.cos(guard.heading) * (CFG.guardRadius + 6),
                oy + Math.sin(guard.heading) * (CFG.guardRadius + 6));
        });
    }

    drawFx(time) {
        const g = this.fxGfx;
        g.clear();
        if (!this.emp) { return; }
        const t = (time - this.emp.start) / this.emp.dur;
        if (t >= 1) { this.emp = null; return; }
        const r = CFG.empRadius * Math.sin(t * Math.PI / 2);
        g.lineStyle(5, 0x66f0ff, 1 - t);
        g.strokeCircle(this.emp.x, this.emp.y, r);
        g.lineStyle(2, 0xffffff, (1 - t) * 0.7);
        g.strokeCircle(this.emp.x, this.emp.y, r * 0.8);
    }

    drawHud(time) {
        this.hudText.setText(
            'CORES ' + this.coreCount + '/' + CORES.length +
            '   LIVES ' + this.lives +
            '   TIME ' + this.elapsed.toFixed(1));

        const g = this.hudGfx;
        g.clear();

        // EMP cooldown bar (top right)
        const bw = 200;
        const bx = VIEW_W - bw - 14;
        const by = 12;
        const remain = Math.max(0, this.empReadyAt - time);
        const ready = remain === 0;
        const fill = 1 - remain / CFG.empCooldown;
        g.fillStyle(0x000000, 0.6);
        g.fillRect(bx, by, bw, 16);
        g.fillStyle(ready ? 0x66f0ff : 0x33708a, 1);
        g.fillRect(bx, by, bw * fill, 16);
        g.lineStyle(2, 0x9fe8ff, 1);
        g.strokeRect(bx, by, bw, 16);
        this.empText.setText(ready ? 'EMP READY (SPACE / right click)' : 'EMP recharging...');

        // Minimap (bottom right), 1 px = 10 world px
        const s = 0.1;
        const mw = WORLD_W * s;
        const mh = WORLD_H * s;
        const mx = VIEW_W - mw - 14;
        const my = VIEW_H - mh - 14;
        g.fillStyle(0x000000, 0.6);
        g.fillRect(mx, my, mw, mh);
        g.lineStyle(1, 0x7f93bd, 1);
        g.strokeRect(mx, my, mw, mh);
        g.fillStyle(0x7f93bd, 1);
        this.wallBoxes.forEach(b => {
            g.fillRect(mx + b.x1 * s, my + b.y1 * s, (b.x2 - b.x1) * s, (b.y2 - b.y1) * s);
        });
        g.fillStyle(0xffd84a, 1);
        this.cores.forEach(c => g.fillRect(mx + c.x * s - 1, my + c.y * s - 1, 3, 3));
        this.guards.forEach(gd => {
            g.fillStyle(STATE_COLOR[gd.state], 1);
            g.fillCircle(mx + gd.obj.x * s, my + gd.obj.y * s, 3);
        });
        g.fillStyle(0x4de1ff, 1);
        g.fillCircle(mx + this.player.x * s, my + this.player.y * s, 3);
        const cam = this.cameras.main;
        g.lineStyle(1, 0xffffff, 0.5);
        g.strokeRect(mx + cam.scrollX * s, my + cam.scrollY * s, VIEW_W * s, VIEW_H * s);
    }
}

// ---------------------------------------------------------------------
// PHASER GAME CONFIGURATION
// ---------------------------------------------------------------------
const config = {
    type: Phaser.AUTO,
    width: VIEW_W,
    height: VIEW_H,
    backgroundColor: '#080b12',
    scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH
    },
    physics: {
        default: 'arcade',
        arcade: { debug: false }
    },
    scene: [HeistScene]
};

const game = new Phaser.Game(config);
