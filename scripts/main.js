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

// Asset paths (replace with your local web-accessible .glb files)
const ASSETS = {
    reticle: 'assets/ar-target.glb',
    egg: 'assets/creature_egg.glb',
    dinos: [
        //'assets/op_t-rex.glb', 
        'assets/raptor.glb',
        'assets/stego.glb',
        'assets/tricera.glb',
        'assets/tyranno.glb',
        'assets/velociraptor.glb'
    ],
    foods: [
        
    ]
};

const DINO_REGISTRY = {
    'op_t-rex':       { speed: 0.24, scale: 0.35, power: 85, level: 1, health: 150, diet: 'carnivore', breedName: 'T-Rex' },
    'raptor':         { speed: 0.54, scale: 0.45, power: 45, level: 1, health: 80 , diet: 'carnivore', breedName: 'Raptor' },
    'stego':          { speed: 0.10, scale: 0.50, power: 60, level: 1, health: 200, diet: 'herbivore', breedName: 'Stegosaurus' },
    'tricera':        { speed: 0.30, scale: 0.50, power: 70, level: 1, health: 180, diet: 'herbivore', breedName: 'Triceratops' },
    'tyranno':        { speed: 0.24, scale: 0.40, power: 90, level: 1, health: 160, diet: 'carnivore', breedName: 'Tyrannosaurus' },
    'velociraptor':   { speed: 0.60, scale: 0.45, power: 40, level: 1, health: 75 , diet: 'carnivore', breedName: 'Velociraptor' }
};

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
        document.getElementById('instructions').innerText = "Move phone to scan the floor...";
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
                    document.getElementById('instructions').innerText = "Surface found! Tap to drop the egg.";
                }
                
                // State B: Relocating/Dragging the Egg
                else if (gameState === 'SPAWNED_EGG' && isDragging && eggMesh) {
                    // Extract the floor position coordinates from the active frame hit test
                    const newFloorPosition = new THREE.Vector3();
                    const targetMatrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
                    newFloorPosition.setFromMatrixPosition(targetMatrix);

                    // Smoothly slide the egg to the new floor contact position
                    eggMesh.position.copy(newFloorPosition);
                    document.getElementById('instructions').innerText = "Dragging egg... Double tap to hatch!";
                }
            } else {
                if (gameState === 'SCANNING') reticleGroup.visible = false;
            }
        }

        if (gameState === 'HATCHED' && isWalking && spawnedDino) {
        
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
        if (gameState === 'HATCHED' && lastActiveXRFrame) {
            handleScreenTap(lastActiveXRFrame);
        }

        isSimpleTap = false; // Reset for next input sequence
    }
}

function spawnEgg() {
    gameState = 'SPAWNED_EGG';
    reticleGroup.visible = false; // Hide tracking ring
    document.getElementById('instructions').innerText = "Egg Spawned! Tap the egg to hatch it.";

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
        eggMesh.scale.set(0.5, 0.5, 0.5); 

        scene.add(eggMesh);
        document.getElementById('instructions').innerText = "Egg Ready! Tap it to hatch a dino.";
        document.getElementById('scanning-container').classList.add('hidden');
        document.getElementById('gameplay-container').classList.remove('hidden');
    });
}

function hatchEgg() {
    if (!eggMesh || gameState !== 'SPAWNED_EGG') return; 
    
    gameState = 'HATCHING';
    document.getElementById('game-instructions').innerText = "Hatching your dinosaur... 🦖";

    // 2. Randomly select one dinosaur path from your asset array
    const randomIndex = Math.floor(Math.random() * ASSETS.dinos.length);
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
    if (gameState !== 'HATCHED' || !spawnedDino) return;

    raycaster.setFromCamera(touchPosition, camera);

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
}

function spawnDinosaurProcess(assetPath, position, quaternion) {
    console.log(`[Spawn Process] Loading dinosaur asset from: ${assetPath}`);
    loader.load(assetPath, (gltf) => {
        spawnedDino = gltf.scene;
        dinoAnimations = gltf.animations;

        const filename = assetPath.split('/').pop().replace('.glb', '');

        // 1. Match coordinates exactly to the captured layout parameters
        spawnedDino.position.copy(position);
        spawnedDino.quaternion.copy(quaternion);
        
        const stats = DINO_REGISTRY[filename]

        spawnedDino.userData = {
            speed: stats.speed,
            power: stats.power,
            level: stats.level,
            health: stats.health,
            breedName: filename
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
        
        spawnedDino.scale.set(0.5, 0.5, 0.5); // Custom scale if your dinos look too big/small in AR

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

        overlayText.innerText = "Look! Your dinosaur hatched! 🎉";

        setTimeout(() => {
            // Check if the state hasn't been reset by an exit event
            if (gameState === 'HATCHED') {
                overlayText.style.transition = "opacity 1s ease";
                overlayText.style.opacity = "0";
                
                // Fully unmount from layout system once transition finishes
                setTimeout(() => {
                    overlayText.classList.add('hidden');
                    // Reset styles for future notifications
                    overlayText.style.opacity = "1"; 
                }, 1000);
            }
        }, 10000); // 10000ms = 10 seconds

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
            
            // Look for a baked animation that matches an 'idle' pattern
            let idleClip = dinoAnimations.find(clip => clip.name.toLowerCase().includes('idle'));
            if (!idleClip) {
                idleClip = dinoAnimations[0]; // Fallback to slot 0 if custom naming is missing
            }

            const action = mixer.clipAction(idleClip);
            action.setEffectiveWeight(1.0);
            action.setLoop(THREE.LoopRepeat);
            action.play();
            
            console.log(`[Spawn Process] Active animation clip: ${idleClip.name}`);
        } else {
            console.warn("[Spawn Process] No skeletal animation data detected in asset.");
        }

    }, undefined, (error) => {
        console.error("[Spawn Process] Critical asset compilation error:", error);
        document.getElementById('game-instructions').innerText = "Oh no, the egg failed to open!";
        gameState = 'SPAWNED_EGG'; // Reset state machine so user can try again
    });
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
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