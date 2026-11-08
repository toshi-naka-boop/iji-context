# Makki: source-preserved expression edits

Created with the built-in image_gen tool, followed by user-authorized PIL/numpy compositing. Final files: makki-joy.png, makki-normal.png, makki-down.png. All are 1024 × 1536 RGBA PNGs with real alpha transparency.

Original input: transparent/makki.png (1342 × 2000). Resampled once with Pillow LANCZOS to 1050 × 1564, then placed at (-26, 8) on the target canvas. The same transform is used for all three outputs.

Joy was edited from the resampled original. The original head and neck were restored by copying RGBA bytes, including the original grin. Normal was edited from the assembled joy image, with only the mouth patch retained in the head. Down was edited from the assembled normal image, retaining the neck-rubbing arm and wry mouth, with a local two-pixel translation of the original exposed brows. Eyes and nose were restored exactly in all outputs.

Central uniform, original ID lettering, and source-derived chest emblem/text were composited back. The chest emblem/text patch was scaled and positioned in the clear space between the happy fist and lapel. The original body width, head tilt, and build were retained.

Pixel verification: joy's entire locked head matches the resampled original exactly; normal's locked head outside the mouth matches joy exactly; down's protected head/neck outside mouth/brows matches normal exactly. Eyes and nose have zero changed pixels. The exposed neck core below the jaw has zero changed pixels across all outputs.

Contact exception: in down, the new hand occupies previously transparent space behind the original ear/hair. Source alpha is blended at that intentional contact only to avoid holes/halos in the hand. Those edge RGBA pixels are not byte-identical; the original head shape is retained. Thus byte-identical protected regions are verified, while a claim of byte identity at every hand-contact edge would be inaccurate.

Numerical results and output hashes: [makki-preservation-verification.json](makki-preservation-verification.json).

## Built-in edit prompts

### Step 1: arms

```text
Use case: identity-preserve / precise-object-edit.
Edit target: attached precomposed 1024x1536 portrait of the waving man. This is the ORIGINAL man, already scaled and placed correctly. Produce ONE image in exactly this same 1024x1536 composition.
EDIT ONLY THE ARMS. Lower and remove the open waving hand. Bend BOTH arms so both hands make SMALL relaxed happy fists at chest height, approximately viewer-left fist centered (240,925), viewer-right fist centered (880,925). Fists separated from face, chest emblem, lanyard, and ID. Friendly modest celebration, relaxed shoulders. Anatomically correct male hands: four curled fingers and one thumb naturally outside folded fingers, natural wrists, same sturdy forearms. Sleeve cuffs navy and cyan as original. Keep original torso width and shoulder placement, sleeve changes only as needed.
DO NOT redraw or alter ANY of his head or neck: keep exact tousled brown hair silhouette, brown eyes, thick eyebrows, broad full face, rounded jaw, thick neck, original head tilt, gaze, tan skin, and especially the EXACT big toothy grin already present. Crown and chin stay at exactly current coordinates, no head scaling or moving.
Keep torso, jacket, piping, shirt, turtleneck, lanyard, ID badge, round chest and collar emblems unchanged. Original stocky sturdy build, wide torso. Text verbatim: chest AI / SUPPORT, ID AI SUPPORT / STAFF.
Same polished anime linework and soft cel shading. Crop at waist as existing target. REAL ALPHA TRANSPARENCY, no background, no gradient, no checkerboard texture, no shadow/glow/effects. Preserve transparent silhouette edges. Only the sleeve/arm/hand regions are editable.
```

### Step 1: fist placement correction

```text
Use case: precise-object-edit. Edit this 1024x1536 character illustration. Change ONLY both bent arms, sleeves, cuffs and hands. Move BOTH small happy fists UP by about 160 pixels, so their knuckles are at y=770 to 800 and their wrists at y=1000. Place the viewer-left fist around x=220,y=865 and viewer-right fist around x=940,y=865. Friendly modest happy chest-height fists, elbows remain low. The hands must be ABOVE and BESIDE the round chest AI emblem, leaving the entire original chest badge and SUPPORT text unobscured. Use four naturally curled fingers and a thumb folded outside on each fist, correct anatomy. Preserve the original sturdy body proportions. Keep head, hair, neck, exact toothy grin, eyes, brows, face outline, head tilt, and all other features ABSOLUTELY UNCHANGED. Keep the torso, shirt, cyan piping, dark turtleneck, lanyard, original uniform chest and collar emblems and ID unchanged. Text AI SUPPORT / STAFF. Same polished anime style. Keep EXACT same 1024x1536 canvas and crop. TRUE alpha transparent background, alpha zero around the character, no background or shadow.
```

### Step 2: normal

```text
Use case: identity-preserve. STEP 2. Edit the attached finalized STEP 1 JOY portrait of Makki. ONE 1024x1536 PNG, same exact composition.
ONLY TWO CHANGES:
1. Relax and lower BOTH arms naturally at his sides. Remove both fists. Hands rest down out of frame below the waist crop. Same broad shoulders and sturdy body. Natural white/navy/cyan jacket sleeves.
2. Replace ONLY his toothy open grin with a calm friendly CLOSED-MOUTH smile. No teeth or mouth opening. A subtle natural gently curved closed smile, warm and friendly, original skin shading.
KEEP EVERY OTHER HEAD PIXEL AND ALL NECK PIXELS IN EXACTLY THE SAME POSITION. Same original broad full face and jaw outline, cheek volume, thick neck, eye shape and gaze, brown irises, thick brows, original head tilt, hairstyle, hair silhouette and highlights, ears, nose. Do not narrow or reshape face or neck. Do not move or resize head. No other expression change. No eyebrow or eye changes.
Keep exact torso size and uniform design, navy turtleneck, light blue shirt, lanyard, collar emblem and chest emblem, readable text AI / SUPPORT and ID AI SUPPORT / STAFF. Same polished anime style.
Real alpha transparency outside character, clean edges, no backdrop, no checkerboard, no shadows or halo. Preserve 1024x1536 canvas, waist crop, head scale and placement.
```

### Step 3: down

```text
Use case: identity-preserve. STEP 3. Edit the attached finalized STEP 2 NORMAL Makki portrait into a mildly rueful "ah, that's a shame" variation. ONE 1024x1536 transparent PNG.
ONLY these edits:
- The arm on the VIEWER'S LEFT bends upward, with one hand rubbing the BACK of his neck. Elbow out naturally at viewer-left. Palm and fingers rest at the nape BEHIND the original left ear/neck/hair, a relaxed casual neck rub. The visible part of the hand is to the LEFT of the neck, around x=300..400,y=535..665, the forearm runs down along left side. Five anatomically correct digits, some naturally hidden behind hair/neck. Keep the FRONT OF THE NECK and head outline UNALTERED and uncovered. Do not move the head, jaw or neck to make room. Other arm stays lowered at his side.
- Change the closed-mouth smile to a subtle mild wry asymmetric closed smile: friendly "ah well", only a little disappointed, still smiling, no sadness. A tiny asymmetric mouth change, no teeth.
- Eyebrows ONLY very slightly lower, about 2 pixels lower, subtle rueful warmth. Keep EXACT original eye shape, brown irises, pupils, gaze, eyelids and nose unchanged.
Preserve every other head/neck detail: full round original face, wide jaw, full cheeks, thick neck, hair silhouette, every strand and highlight, ears, head tilt, gaze and placement. Do not resize, shift, thin, sharpen or redraw face outline. No head tilt change. No tears, sweat, droopy sad eyes, frown, distress, lowered head or slumped shoulders. Same sturdy broad torso.
Preserve exact uniform with cyan piping/navy panels, turtleneck, shirt, blue lanyard, collar/chest AI emblems and ID, exact text AI / SUPPORT and AI SUPPORT / STAFF. Keep badge visible. Same polished anime linework and soft cel shading. Same 1024x1536 composition with near-top large head and waist crop.
TRUE ALPHA TRANSPARENCY: alpha=0 outside character, no backdrop, no halo, no shadow, no checkerboard.
```

