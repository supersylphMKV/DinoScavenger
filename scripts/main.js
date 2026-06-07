import * as THREE from 'three';
import { ARButton } from 'three/addons/webxr/ARButton.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

let container, camera, scene, renderer;
let reticleGroup, eggMesh = null, spawnedDino = null;
let hitTestSource = null;
let hitTestSourceRequested = false;
let eggHeight = 0.15;
let gameState = 'SCANNING'; // SCANNING, SPAWNED_EGG, HATCHED
let lastActiveXRFrame = null; // Store the most recent XRFrame for use in touch events
let dinoAnimations = []; // Cache for animation clips by name

const raycaster = new THREE.Raycaster();
const touchPosition = new THREE.Vector2();

let isSimpleTap = true;
let isDragging = false;
let lastTapTime = 0; 
const DOUBLE_TAP_DELAY = 300;

let dinoIndex = -1; // To track which dinosaur is currently active for navigation purposes
// Asset paths (replace with your local web-accessible .glb files)
const ASSETS = {
    reticle: 'assets/ar-target.glb',
    egg: 'assets/creature_egg.glb',
    dinos: [
        'assets/raptor.glb',
        'assets/stego.glb',
        'assets/tricera.glb',
        'assets/tyranno.glb',
        'assets/velociraptor.glb'
    ],
    pickables: [
        { path: 'assets/meat.glb', type: 'food', itemCategory: 'meat' },
        { path: 'assets/fish.glb', type: 'food', itemCategory: 'meat' },
        { path: 'assets/pumpkin.glb', type: 'food', itemCategory: 'plant' },
        { path: 'assets/strawberry.glb', type: 'food', itemCategory: 'plant' },
        { path: 'assets/watermelon.glb', type: 'food', itemCategory: 'plant' },
        { path: 'assets/video_game_coin.glb', type: 'item', itemCategory: 'coin' }
    ]
};

const DINO_REGISTRY = {
    'raptor':         { speed: 0.50, scale: .40, power: 45, level: 1, health: 80 , diet: 'carnivore', breedName: 'Raptor' },
    'stego':          { speed: 0.07, scale: .40, power: 60, level: 1, health: 200, diet: 'herbivore', breedName: 'Stegosaurus' },
    'tricera':        { speed: 0.08, scale: .40, power: 70, level: 1, health: 180, diet: 'herbivore', breedName: 'Triceratops' },
    'tyranno':        { speed: 0.15, scale: .40, power: 90, level: 1, health: 160, diet: 'carnivore', breedName: 'Tyrannosaurus' },
    'velociraptor':   { speed: 0.18, scale: .25, power: 40, level: 1, health: 75 , diet: 'carnivore', breedName: 'Velociraptor' }
};

// --- SPATIAL GRID CONFIGURATION ---
const CELL_SIZE = .25;            // Each grid cell represents 1x1 meter
const GRID_EXTENT = 5;            // Radius of grid cells to look around (-5 to +5)
const MAX_STAGE_ITEMS = 6;        // Absolute limit of pickables allowed on stage at once
const PICKABLE_LIFETIME = 30;     // Time in seconds before an item despawns

// Tracking storage arrays
let activePickables = [];         // Array to hold metadata objects for all live items on stage
let foodSpawnTimeoutID = null;     // Reusing your timing handle loop
let spawnedFoodMesh = null;        // To track if the dinosaur is currently targeting a food item for scavenging
let foodScavengeActive = false;  

let pickableMixers = [];// Flag to prevent multiple simultaneous scavenging processes

let mixer = null; // For handling animations if using GLTF models with animations
const clock = new THREE.Clock();
const loader = new GLTFLoader();

//handling walking into target location after hatching
let targetDestination = new THREE.Vector3();
let isWalking = false;
let rotationSpeed = 4.0; // Dynamic smoothing velocity

init();

function init() {
    container = document.createElement('div');
    document.body.appendChild(container);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.8); // High intensity (1.8)
    scene.add(ambientLight);
    
    const sunLight = new THREE.DirectionalLight(0xffffff, 2.5); // Strong intensity (2.5)
    sunLight.position.set(1, 4, 1); // Positioned above, slightly to the front/right
    scene.add(sunLight);

    // 3. Fill Light illuminates the back/opposite side of the model
    const fillLight = new THREE.DirectionalLight(0xddeeff, 1.0); 
    fillLight.position.set(-1, 2, -1);
    scene.add(fillLight);

    // Renderer Setup
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.xr.enabled = true; // Turn on WebXR engine
    renderer.outputColorSpace = THREE.SRGBColorSpace; // Forces vibrant, true sRGB colors
    renderer.toneMapping = THREE.ACESFilmicToneMapping; // Simulates HDR filmic lighting levels
    renderer.toneMappingExposure = 1.0;
    container.appendChild(renderer.domElement);

    renderer.xr.addEventListener('sessionstart', () => {
        const overlay = document.getElementById('ar-overlay');
        
        // Reset the UI screen states in case this is a second playthrough
        document.getElementById('scanning-container').classList.remove('hidden');
        document.getElementById('gameplay-container').classList.add('hidden');
        document.getElementById('instructions').innerText = "Gerakan gadget untuk memindai lantai...";
    });

    // Triggered if the user hits the "Exit AR" button or closes the app browser window
    renderer.xr.addEventListener('sessionend', () => {
        const overlay = document.getElementById('ar-overlay');
        document.getElementById('scanning-container').classList.add('hidden');
        document.getElementById('gameplay-container').classList.add('hidden');
    });

    // Create WebXR "Start AR" Button with the hit-test feature requested
    document.body.appendChild(ARButton.createButton(renderer, { 
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: document.getElementById('ar-overlay') }
    }));

    // Build targeting reticle (a flat horizontal ring)
    reticleGroup = new THREE.Group();
    reticleGroup.visible = false;
    reticleGroup.matrixAutoUpdate = false; 
    scene.add(reticleGroup);

    loader.load(ASSETS.reticle, (gltf) => {
        const customReticleMesh = gltf.scene;

        customReticleMesh.traverse((child) => {
            if (child.isMesh) {
                child.material.side = THREE.DoubleSide; // Visible from top and bottom
                child.material.transparent = false;
                // If it's still invisible, force it to be bright green to test it:
                // child.material.color.setHex(0x00ff00); 
            }
        });

        customReticleMesh.scale.set(0.5, 0.5, 0.5); // Adjust size if needed

        reticleGroup.add(customReticleMesh);

    }, undefined, (error) => {
        console.error("Error loading reticle:", error);
        document.getElementById('instructions').innerText = error;

        const fallbackGeo = new THREE.BoxGeometry(0.2, 0.02, 0.2);
        const fallbackMat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const fallbackMesh = new THREE.Mesh(fallbackGeo, fallbackMat);
        reticleGroup.add(fallbackMesh);

    });

    const creditsModal = document.getElementById('credits-modal-popup');

    document.getElementById('credits-trigger-btn').addEventListener('click', () => {
        creditsModal.classList.remove('hidden');
    });

    document.getElementById('credits-close-btn').addEventListener('click', () => {
        creditsModal.classList.add('hidden');
    });

    document.getElementById('system-overlay-container').classList.remove('hidden');

    window.addEventListener('touchstart', onTouchStart, { passive: false });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: false });

    window.addEventListener('resize', onWindowResize);

    // Start the XR frame loop animation
    renderer.setAnimationLoop(renderFrame);

    setupEnvironmentLighting();
}

// --- Core WebXR Logic ---
function renderFrame(timestamp, frame) {
    const delta = clock.getDelta();

    if (mixer) mixer.update(delta);

    for (let itemMixer of pickableMixers) {
        itemMixer.update(delta);
    }

    if (frame) {
        const session = renderer.xr.getSession();

        if (hitTestSourceRequested === false) {
            session.requestReferenceSpace('viewer').then((referenceSpace) => {
                session.requestHitTestSource({ space: referenceSpace }).then((source) => {
                    hitTestSource = source;
                });
            });
            
            session.addEventListener('end', () => {
                hitTestSourceRequested = false;
                hitTestSource = null;
            });
            hitTestSourceRequested = true;
        }

        // 1. Initialize Hit Test Source once session starts
        if (hitTestSource) {
            const referenceSpace = renderer.xr.getReferenceSpace();
            
            // WebXR natively performs a hit-test relative to the user's screen space
            const hitTestResults = frame.getHitTestResults(hitTestSource);

            if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const pose = hit.getPose(referenceSpace);

                // State A: Standard Scanning
                if (gameState === 'SCANNING') {
                    reticleGroup.visible = true;
                    reticleGroup.matrix.fromArray(pose.transform.matrix);
                    
                    document.getElementById('scanning-container').classList.add('hidden');
                    document.getElementById('instructions').innerText = "Lantai terdeteksi! Tap layar untuk menaruh telur.";
                }
                
                // State B: Relocating/Dragging the Egg
                else if (gameState === 'SPAWNED_EGG' && isDragging && eggMesh) {
                    // Extract the floor position coordinates from the active frame hit test
                    const newFloorPosition = new THREE.Vector3();
                    const targetMatrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
                    newFloorPosition.setFromMatrixPosition(targetMatrix);

                    // Smoothly slide the egg to the new floor contact position
                    eggMesh.position.copy(newFloorPosition);
                    document.getElementById('instructions').innerText = "Tap untuk memindahkan telur, double-tap untuk menetaskan!";
                }
            } else {
                if (gameState === 'SCANNING') reticleGroup.visible = false;
            }
        }

        if (gameState === 'PLAYING') {
    
            if(isWalking && spawnedDino) {
                // 1. Calculate horizontal vector gap between Dino and Target
                const currentPos = spawnedDino.position;
                const distanceToTarget = currentPos.distanceTo(targetDestination);

                // Arrive Safety Threshold: Stop moving if within 3 centimeters
                if (distanceToTarget > 0.03) {
                    
                    // Vector calculation pointing from Dino out to target location
                    const direction = new THREE.Vector3().subVectors(targetDestination, currentPos);
                    direction.y = 0; // Lock plane vectors so dino doesn't fly upwards
                    direction.normalize();

                    // Translate dino position forward frame-by-frame
                    const currentDinoSpeed = spawnedDino.userData.speed;
                    currentPos.addScaledVector(direction, currentDinoSpeed * delta);

                    // 2. HANDLE ROTATION WITH YOUR MODEL'S FORWARD VECTOR OFFSET
                    // Calculate standard geometric target rotation angle
                    const targetAngle = Math.atan2(direction.x, direction.z);
                    const correctedAngle = targetAngle - (Math.PI / 2);

                    // Construct target Quaternion 
                    const targetRotation = new THREE.Quaternion().setFromAxisAngle(
                        new THREE.Vector3(0, 1, 0), 
                        correctedAngle
                    );

                    // Smoothly interpolate current rotation towards target path
                    spawnedDino.quaternion.slerp(targetRotation, rotationSpeed * delta);

                } else {
                    // --- TARGET ARRIVED LIFESTAGE RECOVERY ---
                    isWalking = false;
                    if (reticleGroup) reticleGroup.visible = false;

                    if (foodScavengeActive && spawnedFoodMesh) {
                        foodScavengeActive = false;
                        
                        // Find the matching tracking record from our active list
                        const consumedRecord = activePickables.find(item => item.mesh === spawnedFoodMesh);
                        
                        // Execute your unified mixer/mesh cleanup function
                        if (consumedRecord) {
                            despawnPickableRecord(consumedRecord);
                        } else {
                            // Fallback if record was missing but mesh still exists
                            scene.remove(spawnedFoodMesh);
                            spawnedFoodMesh = null;
                        }

                        // Play eating or combat biting animations sequences
                        playOneShotAnimation(['eat', 'attack'], null);
                        console.log("[Gameplay] Target food item successfully consumed at grid coordinates.");

                    }else {
                        // Return cleanly back to the looping Idle animation stance
                        if (mixer && dinoAnimations && dinoAnimations.length > 0) {
                            mixer.stopAllAction();
                            // Access your cached array references to swap clips back smoothly
                            let idleClip = dinoAnimations.find(clip => clip.name.toLowerCase().includes('idle'));
                            if (!idleClip) idleClip = dinoAnimations[0];
                            
                            mixer.clipAction(idleClip).play();
                        }
                        console.log("[Navigation] Destination reached successfully.");
                    }
                }
            }

            if(activePickables.length > 0) {
                // Process backwards down the stack array list structure to handle deletes safely without index skips
                for (let i = activePickables.length - 1; i >= 0; i--) {
                    const item = activePickables[i];
                    
                    // Subtract frame delta time calculations
                    item.timeRemaining -= delta;

                    // Despawn check when time ticks down to zero
                    if (item.timeRemaining <= 0) {
                        console.log(`[Lifecycle] ${item.category} has spoiled/expired. Despawning.`);
                        
                        scene.remove(item.mesh); // Erase from viewport 3D rendering stack pipeline
                        
                        // If the dinosaur was actively walking toward this item, break its tracking flags
                        if (spawnedFoodMesh === item.mesh) {
                            spawnedFoodMesh = null;
                            isWalking = false;
                            foodScavengeActive = false;
                            returnToIdleStance();
                        }

                        activePickables.splice(i, 1); // Unlink object from tracking runtime registry memories
                    }
                }
            }
        }

        lastActiveXRFrame = frame; // Update the most recent XRFrame for use in touch events
    }

    renderer.render(scene, camera);
}

function onTouchStart(event) {
    if (event.touches.length !== 1) return; // Only track single-finger inputs

    isSimpleTap = true;

    // 1. Convert mobile screen pixel coordinates into normalized [-1, 1] 3D space
    touchPosition.x = (event.touches[0].clientX / window.innerWidth) * 2 - 1;
    touchPosition.y = -(event.touches[0].clientY / window.innerHeight) * 2 + 1;

    // 2. Cast a ray from the camera through the touch position
    raycaster.setFromCamera(touchPosition, camera);

    if (gameState === 'SCANNING' && reticleGroup.visible) {
        // If scanning and floor is targeted, a single tap drops the egg
        spawnEgg();
    } 
    else if (gameState === 'SPAWNED_EGG' && eggMesh) {
        // Check if the user touched the egg specifically
        const intersects = raycaster.intersectObject(eggMesh, true);

        if (intersects.length > 0) {
            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTapTime;

            if (tapLength < DOUBLE_TAP_DELAY && tapLength > 0) {
                // SUCCESS: User double-tapped the egg model
                hatchEgg();
                isDragging = false;
            } else {
                // User single-tapped the egg, initiate drag sequence
                isDragging = true;
            }
            lastTapTime = currentTime;
        }
    }
}

function onTouchMove(event) {
    isSimpleTap = false; 

    if (!isDragging || gameState !== 'SPAWNED_EGG' || !eggMesh) return;

    touchPosition.x = (event.touches[0].clientX / window.innerWidth) * 2 - 1;
    touchPosition.y = -(event.touches[0].clientY / window.innerHeight) * 2 + 1;

}

function onTouchEnd(event) {
    // End the dragging state when user lifts their finger off the screen
    isDragging = false;

    if(isSimpleTap) {
        if (lastActiveXRFrame) {
            handleScreenTap(lastActiveXRFrame);
        }

        isSimpleTap = false; // Reset for next input sequence
    }
}

function spawnEgg() {
    gameState = 'SPAWNED_EGG';
    reticleGroup.visible = false; // Hide tracking ring
    document.getElementById('game-instructions').innerText = "Telur muncul! Tap telur untuk menetaskan.";

    loader.load(ASSETS.egg, (gltf) => {
        eggMesh = gltf.scene;
        
        eggMesh.traverse((child) => {
            if (child.isMesh && child.material) {
                // Adjust exposure constraints built into the material
                child.material.roughness = 0.4; // Lower values make it look shinier/less dry
                child.material.metalness = 0.1; // Lower values prevent it from turning black/metallic
                
                // Force color mapping space transformation configuration
                if (child.material.map) {
                    child.material.map.colorSpace = THREE.SRGBColorSpace;
                }
                
                // Safety: Tell the material shader to update its color calculations
                child.material.needsUpdate = true;
            }
        });

        // Match the precise position and orientation of the floor hit-test matrix
        eggMesh.position.setFromMatrixPosition(reticleGroup.matrix);
        eggMesh.quaternion.setFromRotationMatrix(reticleGroup.matrix);
        
        const eggBoundingBox = new THREE.Box3().setFromObject(eggMesh);
        const eggSize = new THREE.Vector3();
        eggBoundingBox.getSize(eggSize); // Extracts width, height, depth into vector
        eggHeight = eggSize.y; // Capture the exact vertical height
        // Custom scale scaling down/up if your models look tiny or giant in AR
        eggMesh.scale.set(0.4, 0.4, 0.4); 

        scene.add(eggMesh);
        document.getElementById('game-instructions').innerText = "Telur siap! Tap telur untuk menetaskan.";
        document.getElementById('scanning-container').classList.add('hidden');
        document.getElementById('gameplay-container').classList.remove('hidden');
    });
}

function hatchEgg() {
    if (!eggMesh || gameState !== 'SPAWNED_EGG') return; 
    
    gameState = 'HATCHING';
    document.getElementById('game-instructions').innerText = "Tunggu... Dino sedang menetas 🦖";

    // 2. Randomly select one dinosaur path from your asset array
    const randomIndex = dinoIndex > -1 && dinoIndex < ASSETS.dinos.length ? dinoIndex : Math.floor(Math.random() * ASSETS.dinos.length);
    const chosenDinoPath = ASSETS.dinos[randomIndex];

    // 3. Capture the exact location coordinates of the egg before deleting it
    const spawnPosition = new THREE.Vector3();
    const spawnQuaternion = new THREE.Quaternion();
    spawnPosition.copy(eggMesh.position);
    spawnQuaternion.copy(eggMesh.quaternion);

    // 4. Cleanly erase the egg mesh from the 3D scene
    scene.remove(eggMesh);
    eggMesh = null; // Clear allocation from memory

    // 5. Trigger the separated dinosaur spawning process
    spawnDinosaurProcess(chosenDinoPath, spawnPosition, spawnQuaternion);
}

function handleScreenTap(frame) {
    if (!spawnedDino) return;

    const gameInstructionBox = document.getElementById('game-instruction-box');
    const overlayText = document.getElementById('game-instructions');

    if(gameState === 'PLAYING') {
        raycaster.setFromCamera(touchPosition, camera);

        let clickedItemRecord = null;
    
        for (let item of activePickables) {
            const intersects = raycaster.intersectObject(item.mesh, true);
            if (intersects.length > 0) {
                clickedItemRecord = item;
                break; // Target successfully captured! End loop iterations early.
            }
        }

        if (clickedItemRecord) {
            // Evaluate behaviors based on item category parameters
            if (clickedItemRecord.type === 'food') {
                // Map parameters back into your existing evaluation process pipelines cleanly
                spawnedFoodMesh = clickedItemRecord.mesh;
                currentFoodType = clickedItemRecord.category;
                
                processDietEvaluation();
            } 
            else if (clickedItemRecord.type === 'item') {
                console.log(`[Interaction] Item picked up: ${clickedItemRecord.category}! Running coin logic...`);
                
                // Coin collection placeholder sequence: instantly clear it
                scene.remove(clickedItemRecord.mesh);
                activePickables = activePickables.filter(i => i !== clickedItemRecord);
                
                // Play a custom roar or spin animation here if desired!
            }
            return; // Terminate execution blocks cleanly so empty floor clicks aren't generated
        }

        const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -spawnedDino.position.y);
        const intersectionPoint = new THREE.Vector3();
        
        // 3. Find exactly where the screen ray intercepts our floor plane equations
        if (raycaster.ray.intersectPlane(floorPlane, intersectionPoint)) {
            
            // Success! Copy the coordinates directly
            targetDestination.copy(intersectionPoint);

            reticleGroup.matrixAutoUpdate = true; // Allow manual positioning

            if (!reticleGroup) {
                const circleGeo = new THREE.RingGeometry(0.12, 0.15, 32);
                circleGeo.rotateX(-Math.PI / 2);
                const circleMat = new THREE.MeshBasicMaterial({ color: 0x00ff55, side: THREE.DoubleSide });
                reticleGroup = new THREE.Mesh(circleGeo, circleMat);
                scene.add(reticleGroup);
            }
            
            reticleGroup.position.copy(targetDestination);
            reticleGroup.rotation.set(0, 0, 0); // Flat on the floor
            reticleGroup.visible = true;

            // Kick off walking engine
            isWalking = true;

            // Play animation track
            if (mixer && dinoAnimations && dinoAnimations.length > 0) {
                mixer.stopAllAction();
                let walkClip = dinoAnimations.find(clip => clip.name.toLowerCase().includes('walk'));
                if (!walkClip) walkClip = dinoAnimations[0];
                mixer.clipAction(walkClip).play();
            }
        }
    }else if (gameState === 'HATCHED') {
        overlayText.innerText = "Hello, Aku adalah " + spawnedDino.userData.breedName;
        gameState = 'GREETINGS';
    }else if (gameState === 'GREETINGS') {
        overlayText.innerText = "Aku harus mencari ibuku... Maukah kamu membantuku?";
        gameState = 'AWAITING_HELP_RESPONSE';
    }else if (gameState === 'AWAITING_HELP_RESPONSE') {
        overlayText.innerText = "Terima kasih! Sekarang bantu aku tumbuh kuat!";
        gameState = 'ROARING';
        playOneShotAnimation(['roar','attack2'], () => {
            gameState = 'PLAYING';
            gameInstructionBox.classList.add('hidden');
            startFoodSpawningLoop();

            document.getElementById('gameplay-hud-container').classList.remove('hidden');

            // --- DYNAMIC GIMMICKS: PASS USERDATA STATS INTO HUD ELEMENTS ---
            if (spawnedDino && spawnedDino.userData) {
                document.getElementById('hud-level-text').innerText = spawnedDino.userData.level || 1;
                document.getElementById('hud-xp-filler').style.width = "45%";
            }
        });
    }
}

function spawnDinosaurProcess(assetPath, position, quaternion) {
    console.log(`[Spawn Process] Loading dinosaur asset from: ${assetPath}`);
    loader.load(assetPath, (gltf) => {
        spawnedDino = gltf.scene;
        dinoAnimations = gltf.animations;
        console.log('[Animations] Detected animation clips:', dinoAnimations.map(clip => clip.name));
        const filename = assetPath.split('/').pop().replace('.glb', '');

        // 1. Match coordinates exactly to the captured layout parameters
        spawnedDino.position.copy(position);
        spawnedDino.quaternion.copy(quaternion);
        
        const stats = DINO_REGISTRY[filename]

        spawnedDino.userData = {
            speed: stats.speed,
            scale: stats.scale,
            power: stats.power,
            level: stats.level,
            health: stats.health,
            diet: stats.diet,
            breedName: stats.breedName
        };
        
        // 2. Apply PBR Material corrections for optimal mobile rendering
        spawnedDino.traverse((child) => {
            if (child.isMesh && child.material) {
                child.material.roughness = 0.5;
                child.material.metalness = 0.1;
                if (child.material.map) child.material.map.colorSpace = THREE.SRGBColorSpace;
                child.material.needsUpdate = true;
            }
        });

        // 3. Inject the finished model into the active WebXR viewport scene
        scene.add(spawnedDino);
        
        spawnedDino.scale.set(spawnedDino.userData.scale, spawnedDino.userData.scale, spawnedDino.userData.scale); // Custom scale if your dinos look too big/small in AR

        const cameraPosition = new THREE.Vector3();
        camera.getWorldPosition(cameraPosition);

        // 2. Create a target vector at the dinosaur's height 
        // This keeps the dino's spine perfectly vertical so it doesn't tilt up or down
        const targetPosition = new THREE.Vector3(
            cameraPosition.x,
            spawnedDino.position.y, // Lock vertical plane to the dinosaur's current floor height
            cameraPosition.z
        );

        // 3. Tell the dinosaur mesh to rotate toward that point
        spawnedDino.lookAt(targetPosition);
        spawnedDino.rotateY(-Math.PI / 2);
        
        // 4. Finalize game state updates
        gameState = 'HATCHED';

        const overlayText = document.getElementById('game-instructions');

        overlayText.innerText = "Lihat! Dino kamu muncul! 🎉";

        // 5. Initialize Animation System
        if (dinoAnimations && dinoAnimations.length > 0) {
            let animationTarget = spawnedDino;
            spawnedDino.traverse((child) => {
                if (child.isBone || child.isSkinnedMesh) {
                    // Find the top-level parent of the bones (usually the Armature object)
                    if (child.parent && !animationTarget.isBone) {
                        animationTarget = child.parent;
                    }
                }
            });
            mixer = new THREE.AnimationMixer(animationTarget);
            
            returnToIdleStance(); // Start in idle stance
        } else {
            console.warn("[Spawn Process] No skeletal animation data detected in asset.");
        }

    }, undefined, (error) => {
        console.error("[Spawn Process] Critical asset compilation error:", error);
        document.getElementById('game-instructions').innerText = "Aduh, terjadi kesalahan. Coba lagi ya!";
        gameState = 'SPAWNED_EGG'; // Reset state machine so user can try again
    });
}

function startFoodSpawningLoop() {
    if (foodSpawnTimeoutID) clearTimeout(foodSpawnTimeoutID);

    // Dynamic tick: evaluate scene requirements every 3 to 6 seconds
    const loopInterval = Math.random() * 3000 + 3000;

    foodSpawnTimeoutID = setTimeout(() => {
        if (gameState === 'PLAYING' && spawnedDino) {
            // Check if we have room under our stage ceiling thresholds
            if (activePickables.length < MAX_STAGE_ITEMS) {
                proceduralGridSpawn();
            }
        }
        startFoodSpawningLoop(); // Keep ticking recursively
    }, loopInterval);
}

function proceduralGridSpawn() {
    if (ASSETS.pickables.length === 0) return;

    // 1. Establish structural tracking baselines based on where the dinosaur stands right now
    const dinoPos = spawnedDino.position;
    
    // Find the absolute root anchor grid index center cell coordinates matching 1-meter locks
    const centerCellX = Math.round(dinoPos.x / CELL_SIZE);
    const centerCellZ = Math.round(dinoPos.z / CELL_SIZE);

    // 2. Identify currently blocked cells on stage to prevent intersection overlaps
    // Create a quick lookup map string key format: "X,Z"
    const occupiedCells = new Set();
    
    // Block the center cell so things don't spawn directly inside or underneath the dinosaur model
    occupiedCells.add(`${centerCellX},${centerCellZ}`);

    activePickables.forEach(item => {
        const itemCellX = Math.round(item.mesh.position.x / CELL_SIZE);
        const itemCellZ = Math.round(item.mesh.position.z / CELL_SIZE);
        occupiedCells.add(`${itemCellX},${itemCellZ}`);
    });

    // 3. Build a list of all completely vacant cells within our 11x11 zone limits
    const vacantCells = [];

    for (let offsetX = -GRID_EXTENT; offsetX <= GRID_EXTENT; offsetX++) {
        for (let offsetZ = -GRID_EXTENT; offsetZ <= GRID_EXTENT; offsetZ++) {
            
            const targetCellX = centerCellX + offsetX;
            const targetCellZ = centerCellZ + offsetZ;
            const cellKey = `${targetCellX},${targetCellZ}`;

            if (!occupiedCells.has(cellKey)) {
                vacantCells.push({ x: targetCellX, z: targetCellZ });
            }
        }
    }

    // Edge case: if the stage is completely locked, skip this loop step cleanly
    if (vacantCells.length === 0) {
        console.warn("[Grid Spawner] No open sectors found around dinosaur right now.");
        return;
    }

    // 4. Select a random entry out of the list of safe vacant cells
    const chosenCell = vacantCells[Math.floor(Math.random() * vacantCells.length)];

    // 5. Randomize position coordinates within that chosen 1-meter cell boundaries
    // (Translates to a minor jitter variation up to +/- 0.4 meters from the absolute node node center points)
    const jitterX = (Math.random() - 0.5) * (CELL_SIZE * 0.8);
    const jitterZ = (Math.random() - 0.5) * (CELL_SIZE * 0.8);

    const absoluteSpawnX = (chosenCell.x * CELL_SIZE) + jitterX;
    const absoluteSpawnZ = (chosenCell.z * CELL_SIZE) + jitterZ;
    const absoluteSpawnY = dinoPos.y; // Keep matching the established ground plane height

    // 6. Roll random item configuration data from asset database references
    const randomPickable = ASSETS.pickables[Math.floor(Math.random() * ASSETS.pickables.length)];

    loader.load(randomPickable.path, (gltf) => {
        // Double check session verification safety constraints
        if (gameState !== 'PLAYING' || !spawnedDino) return;

        const itemMesh = gltf.scene;
        itemMesh.position.set(absoluteSpawnX, absoluteSpawnY, absoluteSpawnZ);
        itemMesh.rotation.y = Math.random() * Math.PI * 2;
        itemMesh.scale.set(0.3, 0.3, 0.3); // Scale adjustment parameters

        itemMesh.traverse((child) => {
            if (child.isMesh && child.material) {
                child.material.roughness = 0.6;
                child.material.metalness = 0.1;
                if (child.material.map) child.material.map.colorSpace = THREE.SRGBColorSpace;
                child.material.needsUpdate = true;
            }
        });

        scene.add(itemMesh);

        let itemMixer = null;

        if (gltf.animations && gltf.animations.length > 0) {
            itemMixer = new THREE.AnimationMixer(itemMesh);
            const defaultClip = gltf.animations[0]; // Play the first baked track (e.g., 'spin', 'float')
            const action = itemMixer.clipAction(defaultClip);
            action.setLoop(THREE.LoopRepeat); // Force it to loop infinitely
            action.play();
            
            pickableMixers.push(itemMixer); // Register it to our global update list
        }

        // 7. Inject metadata tracking block references into runtime collection array structures
        const itemRecord = {
            mesh: itemMesh,
            type: randomPickable.type,                 // 'food' or 'item'
            category: randomPickable.itemCategory,     // 'meat', 'plant', 'coin'
            timeRemaining: PICKABLE_LIFETIME           // Countdown clock tracker
        };

        activePickables.push(itemRecord);
        console.log(`[Grid Spawner] Created ${itemRecord.category} at cell (${chosenCell.x}, ${chosenCell.z})`);
    });
}

function despawnPickableRecord(itemRecord) {
    if (!itemRecord) return;

    // 1. Erase the mesh from the 3D scene viewport graph
    scene.remove(itemRecord.mesh);

    // 2. Unlink and unmount its unique looping animation mixer
    if (itemRecord.mixer) {
        itemRecord.mixer.stopAllAction();
        // Remove it from the global array loop so renderFrame stops updating it
        pickableMixers = pickableMixers.filter(m => m !== itemRecord.mixer);
    }

    // 3. Clear global tracking targets if this was the item the dino was actively chasing
    if (spawnedFoodMesh === itemRecord.mesh) {
        spawnedFoodMesh = null;
        isWalking = false;
        foodScavengeActive = false;
        returnToIdleStance();
    }

    // 4. Filter it completely out of your main stage tracking array
    activePickables = activePickables.filter(i => i !== itemRecord);
    
    console.log(`[Lifecycle] System memory cleared for consumed/expired item.`);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function returnToIdleStance() {
    if (!mixer || !dinoAnimations || dinoAnimations.length === 0) return;
    mixer.stopAllAction();
    let idleClip = dinoAnimations.find(clip => clip.name.toLowerCase().includes('idle')) || dinoAnimations[0];
    const action = mixer.clipAction(idleClip);
    action.setEffectiveWeight(1.0);
    action.setLoop(THREE.LoopRepeat);
    action.play();
}

function playOneShotAnimation(clipName, callback) {
    if (!mixer || !dinoAnimations || dinoAnimations.length === 0) return;
    mixer.stopAllAction();
    let clipNameLower;

    if(clipName instanceof Array) {
        for(let nameOption of clipName) {
            const foundClip = dinoAnimations.find(clip => clip.name.toLowerCase().includes(nameOption.toLowerCase()));
            if(foundClip) {
                clipNameLower = nameOption.toLowerCase();
                break;
            }
        }
    }else if(typeof clipName === 'string') {
        clipNameLower = clipName.toLowerCase();
    }

    if(clipNameLower){
        let tgtClip = dinoAnimations.find(clip => clip.name.toLowerCase().includes(clipNameLower)) || dinoAnimations[0];
        const action = mixer.clipAction(tgtClip);
        mixer.addEventListener('finished', () => {
            returnToIdleStance();
            if (callback) callback();
            mixer.removeEventListener('finished'); // Clean up listener after one use
        });
        action.setEffectiveWeight(1.0);
        action.setLoop(THREE.LoopOnce);
        action.play();
    }else{
        if (callback) callback(); // If no clip found, still call the callback to prevent blocking progression
    }
}

function setupEnvironmentLighting() {
    // A generator that transforms simple gradients into high-fidelity PBR reflections
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    // Create a neutral, soft studio reflection environment map
    const sceneFolder = new THREE.Scene();
    const envLight = new THREE.DirectionalLight(0xffffff, 2.0);
    envLight.position.set(1, 1, 1);
    sceneFolder.add(envLight);

    const renderTarget = pmremGenerator.fromScene(sceneFolder, 0.04);
    
    // Apply this reflection to EVERY model in your scene automatically
    scene.environment = renderTarget.texture;
}