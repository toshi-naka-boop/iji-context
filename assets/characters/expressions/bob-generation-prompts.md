# Bob expression generation

Mode: built-in image_gen, one image generation/edit per call, transparent_background=true. Final PNGs: 1024 x 1536 RGBA.

## Normal

Inputs in order:
1. transparent/bob.png (character identity)
2. transparent/suit.png (composition)
3. Initial normal draft: /Users/toshixa/.codex/generated_images/01a1b47f-6481-7441-b332-58a553b96f9c/exec-cfc90c30-1edd-47cc-9468-816362f0e9ac.png

Use case: identity-preserve.
One 1024x1536 RGBA transparent waist-up anime character sprite.

REFERENCE ROLES:
Image 1 = the only character identity reference. Preserve THIS exact calm bob-haired woman's face and hair.
Image 2 = composition reference ONLY. Copy Image 2's crop, head placement, head size, head tilt and torso rotation, but NOT her face/hair/earrings/smile/arm pose.
Image 3 = a draft of the desired normal pose, showing the right identity, uniform and lowered arms. Its head tilt is WRONG: correct it to match Image 2.

HIGHEST PRIORITY: Image 1's face must match exactly. Same wide large ROUND brown eyes and large round irises, same upper/lower eyelid shape and fine eyelashes, eyebrows, full pink lips, nose, soft pink skin shading, round face outline and wispy bangs. Short chin-length brown bob. No earrings. No changes to facial style, no narrow eyes, no thin lips, no mature face from Image 2. Her neutral composed mouth is almost straight, like Image 1.

FRAMING: exactly Image 2's 1024x1536 portrait waist-up framing. Crown near the top at y~5. Head occupies the same large area as Image 2; eyes near y380-420 and chin near y670. Head is slightly left of center. Torso is turned at Image 2's slight three-quarter angle, with near shoulder viewer-left. Crop torso at the same waist height. Arms hang relaxed downward at her sides; hands largely below the bottom crop. No crossed arms. No waving.

HEAD TILT CORRECTION: Make the eye on the LEFT SIDE OF THE PICTURE HIGHER, about y380; make the eye on the RIGHT SIDE OF THE PICTURE LOWER, about y415. The eye line must visibly descend from picture-left to picture-right like Image 2. The chin is a little to picture-left of the crown. Gaze remains directed at viewer. This is the opposite of Image 3's tilt. Preserve the round eyes, face shape, nose and full lips of Image 1 while setting this head orientation.

Clothes exactly Image 1 / Image 3: white zip-up technical jacket with cyan piping and navy side/underarm panels; light-blue buttoned collared shirt over dark turtleneck; dark-blue cyan-dotted lanyard; ID badge reading exactly 'AI SUPPORT' in blue header, 'STAFF' below. Round cyan 'AI' chest emblem on viewer-right with 'SUPPORT' below. Polished anime illustration, fine crisp linework, soft skin rendering, detailed shaded clothing.

Real alpha transparency, clean antialiased cutout. All pixels around the woman fully transparent. No backdrop, no white/colored background, no vignette, no checkerboard, no shadow, no floating graphics.

## Joy

Input: expressions/bob-normal.png

Use case: identity-preserve / precise-object-edit.
EDIT THIS EXACT NORMAL IMAGE into the JOY variation. 1024x1536 PNG, real alpha transparency. Keep the canvas/camera/body/head/face alignment pixel-registered to the source. Do not resize, shift, rotate, recrop or reframe anything.

ONLY TWO CHANGES:
1. Mouth: turn up both mouth corners VERY SLIGHTLY for a faint, restrained smile. Preserve the same full lip volume, same mouth center, width, slant, skin tone and lip rendering. Mouth remains gently closed, no teeth. A subtle calm smile, no grin.
2. Arms/hands: bring both hands together in a small quiet clap in front of the CHEST, at approximately x420-670, y950-1200. Palms lightly meet, fingers relaxed and together, fingertips pointing gently upward, wrists natural, elbows lowered. Both hands anatomically correct with five fingers each. Modest contained gesture, no broad enthusiastic clapping, no movement marks. Sleeves naturally bend, cyan piping and navy panels remain consistent. No crossed arms, no waving. Keep chest emblem on viewer-right visible; ID badge text still visible below the hands if possible.

LOCK EVERYTHING ELSE: the exact same large round brown eyes and iris sizes, exact eyelids and lashes, eyebrows, nose, cheeks, face outline, ear shapes, short brown bob with wispy bangs. Do not change the eyes at all: no smiling/squinting eyelids. Head stays at its EXACT source x/y coordinates, same size and same tilt, crown near y5, left-of-picture eye higher than right-of-picture eye. Same gaze, same skin color and smooth rendering, same uniform layout, same slight three-quarter torso turn. Preserve the polished anime illustration exactly. Chest emblem 'AI' above 'SUPPORT'; lanyard badge reads 'AI SUPPORT' / 'STAFF' spelled exactly. No accessories.

All surroundings fully transparent alpha, clean antialiased cutout edges. No backdrop, white or colored background, checkerboard, shadow, or floating graphics. Return only the one joy image.

## Down

Input: expressions/bob-normal.png

Use case: identity-preserve / precise-object-edit.
EDIT THIS EXACT NORMAL IMAGE into the DOWN variation. Single 1024x1536 PNG with genuine alpha transparency. Source is the normal image, NOT a joy variation. Keep head/face/camera/canvas/body placement perfectly registered: same exact coordinates, scale, tilt, gaze, three-quarter torso angle and waist crop.

ONLY TWO CHANGES:
1. Mouth: turn the mouth corners DOWN VERY SLIGHTLY, a restrained subtle downturn while remaining calm and composed. Same full soft pink lips, same mouth width, center and tilt, naturally closed, no teeth. No exaggerated sadness, crying, furrowed brow or pouting.
2. Arms/hands: bring both hands LIGHTLY CLASPED together in FRONT OF HER WAIST, LOW in the composition, centered around x490-660 and y1350-1500. One hand rests softly over the other with fingers relaxed, a quiet natural loose clasp, anatomically correct hands with five fingers each. Fingers point gently sideways/down, not upright. Elbows comfortably lowered along the body, forearms slope down inward toward the low waist-level clasp. No crossed arms, no waving, no clasp at chest level. Keep the lanyard ID badge ABOVE the hands in its original place with all text visible. Retain jacket sleeve details and navy/cyan cuff style consistently.

LOCK ALL OTHER FEATURES: exactly the same large round brown eyes, iris sizes and eye shape, lashes, eyelids, eyebrows, nose, cheeks, ears, face outline, short brown bob with the exact same wispy bangs, exact skin rendering and color. Eyes must not become sad, smaller or narrower. Head must NOT move, turn, rotate or change size. Left-of-picture eye remains higher than right-of-picture eye as in source. Same uniform: white technical zip-up jacket with cyan piping and navy panels, light-blue collared button shirt over dark navy turtleneck, dark-blue lanyard. Chest emblem exactly 'AI' with 'SUPPORT' beneath; ID badge exactly 'AI SUPPORT' and 'STAFF' in its original position. Same polished anime illustration style and shading. No accessories.

All surrounding pixels truly alpha-transparent with clean antialiased edges, no backdrop, checkerboard, shadow, vignette, or floating graphics. Return one down expression image only.

## Local compositing

Normalized generated alpha to make near-transparent background pixels fully transparent and character interiors fully opaque while retaining antialiased edges. Cleared hidden RGB where alpha is zero and removed tiny detached alpha specks outside the connected character silhouette.

Copied the normal head and neck into both variants at the exact same coordinates. Only a small feathered mouth ellipse, centered at (476,588), radii (73,43), contains the generated expression. The transition to each generated arm/body pose occurs below the head, between y=780 and y=850. The eyes, brows, nose, face outline, hair and all pixels above y=750 outside the mouth ellipse are byte-identical to the normal image. Verification found zero differences in this locked region in both variants.
