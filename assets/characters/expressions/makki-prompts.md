# Makki expression prompts

Generated with the built-in image_gen tool on 2026-11-07. Each generation/edit used transparent_background=true. Joy and down were independently edited from the final normal image.

Deliverables: makki-normal.png, makki-joy.png, makki-down.png. All verified as 1024x1536 RGBA PNGs, with fully transparent background pixels and antialiased silhouette edges. Source alpha channels were preserved without pixel edits.

## Normal: initial composition and identity generation

```text
Use case: illustration-story. Create ONE final character illustration: Makki normal.
Input 1 (/transparent/suit.png) is ONLY the composition/framing reference: woman with crossed arms. Input 2 (/transparent/makki.png) is the sole character identity/body/uniform/style reference: stocky friendly man waving. Draw only the man, never the woman.

Output: exactly 1024 x 1536 pixels, portrait PNG, genuine alpha transparency. Entire background fully transparent with clean antialiased silhouette. No backdrop, checkerboard, glow, shadow, symbols, effect lines or floating graphics.

COMPOSITION: Match input 1 precisely: same waist-up crop at the bottom, head at the same large scale and same position near the top edge, same slight three-quarter torso rotation toward the same side, same head angle and gaze toward the viewer. In this 1024x1536 canvas the hair crown is very close to the top, face occupies approximately the upper half, shoulders around the canvas midpoint, waist cropped at the bottom. Do not zoom out, make him a small figure, add headroom, or mirror the composition. Transfer framing and orientation only, not female proportions.
IDENTITY AND BUILD ARE CRITICAL: Preserve input 2's EXACT sturdy stocky slightly chubby male build, broad shoulders, thick neck, wide torso, round full face with soft fleshy cheeks and softly rounded jaw. Keep cheek fullness and masculine breadth. Never slim him, narrow the face, sharpen the jaw or make an athletic V-shaped torso. Same tousled curly brown hair, warm brown eyes, thick eyebrows, tan peach skin, warm approachable look. No earrings copied from the woman.
POSE/EXPRESSION: Both arms lowered naturally relaxed at his sides, with hands out of frame at bottom. No waving, no crossed arms. Calm friendly closed-mouth smile, relaxed eyes looking toward viewer.
UNIFORM: Precisely preserve input 2's white zip-up technical jacket with cyan piping and navy side panels and cuffs, light-blue collared shirt over dark navy turtleneck, dark-blue lanyard with cyan details, hanging rectangular ID badge. Round cyan-on-navy 'AI' chest emblem with 'SUPPORT' beneath, and small round 'AI' collar emblem. All text must be clean and spelled verbatim: ID badge top 'AI SUPPORT', lower line 'STAFF'; chest 'AI' and 'SUPPORT'. Preserve correct jacket seam/panel design and accessories.
STYLE: same polished detailed anime illustration, precise confident linework, soft refined cel shading and luminous warm skin as the two supplied inputs.
Create this single normal image only; later expressions will be edits from it.
```

## Normal: composition correction

```text
Edit input 1 (the newly generated Makki normal portrait). Input 2 is the woman's composition guide ONLY; input 3 is Makki's original identity/build guide.
Make the following corrections together to produce the final normal asset:

1. REMOVE THE ENTIRE BACKGROUND. Output a genuine transparent PNG with alpha=0 in every background pixel outside the character, antialiased partially transparent edges only at the silhouette. The brown/black gradient and pale halo visible in input 1 must be entirely absent. Do not copy ANY background from input 2. No colored or white backdrop, no simulated checkerboard transparency, no halo, no shadow, no glow.

2. MATCH THE WOMAN'S HEAD AND BODY ANGLE, which input 1 currently reverses. In the 1024x1536 canvas, align head and shoulders to input 2: the eye on the viewer's LEFT is slightly HIGHER (around y=380) and the eye on the viewer's RIGHT slightly LOWER (around y=410). A small natural head tilt toward viewer's right, face directed toward the viewer as in input 2. Chin near (510,670), crown near the top edge. Body turned toward the SAME side as the woman in input 2. The shoulder on viewer's LEFT is around y=800 and slightly HIGHER than the shoulder on viewer's RIGHT around y=840. Keep the head large and waist-up bottom crop, no extra headroom. Do not simply retain input 1's opposite tilt or high right shoulder. Adapt anatomy naturally to the stocky man.

3. Retain the original Makki identity and EXACT stocky broad build from input 3: sturdy slightly chubby man, thick neck, very broad shoulders, wide torso, round FULL face, soft substantial cheeks and a wide softly rounded jaw. No narrow chin, sharp jaw, slim or athletic body. Keep curly tousled brown hair, warm brown eyes, thick brows, tan skin. Keep calm friendly CLOSED-MOUTH smile. No woman's face, hair, earrings, or crossed arms. Both arms remain relaxed naturally lowered at sides with hands outside the bottom crop.

Keep polished anime rendering and all original male uniform details: white technical jacket with cyan piping/navy panels, light-blue collared shirt over navy turtleneck, dark-blue cyan-detailed lanyard, ID badge. Text verbatim: ID 'AI SUPPORT' / 'STAFF'; round chest emblem 'AI', with 'SUPPORT' under it; small 'AI' collar emblem. Correct readable spelling.

Final output one single 1024x1536 PNG with REAL ALPHA TRANSPARENCY.
```

## Normal: final collar emblem correction

```text
A precise small uniform correction to the attached newly created Makki normal image. Preserve absolutely everything else: exact head tilt, round full friendly face, stocky sturdy wide build, broad shoulders, thick neck, curly brown hair, gaze, closed-mouth smile, lowered arms, composition, 1024x1536 canvas, crop, cyan piping and navy panels, shirt, turtleneck, lanyard, chest badge, ID, and polished anime rendering.
Move the small round cyan 'AI' collar emblem from the collar on the VIEWER'S LEFT to the collar on the VIEWER'S RIGHT, as on Makki's original uniform. Remove it completely from the left collar, leaving the same plain light-blue fabric there, and render the same small round cyan-on-navy 'AI' emblem naturally in perspective on the opposite upright collar. Keep the round CHEST 'AI' emblem and 'SUPPORT' text unchanged on the viewer's right side of the chest. ID text remains exactly 'AI SUPPORT' and 'STAFF'.
Output PNG with genuine alpha transparency, alpha=0 outside the silhouette, clean antialiased edges. Preserve existing transparent background, no shadows, no backdrop, no graphics. Only change the collar emblem placement.
```

## Joy: separate edit from final normal

```text
Use case: identity-preserve. Edit the attached FINAL NORMAL Makki image into the JOY expression. This is an edit of this exact normal image, not a redesign. Produce ONE 1024x1536 PNG.

CHANGE FACE AND UPPER-BODY POSE:
- A big warm cheerful smile showing teeth, like the original waving Makki reference. Softly narrowed happy brown eyes still looking at viewer, lifted cheeks, warm joy.
- BOTH arms bent naturally so BOTH hands form small happy fists at chest height, one on each side of upper chest. Fists just below shoulders, approximately y=900 to 1080, separate from face and ID badge. Lightly raised shoulders and a subtly lively head tilt while preserving original head position/scale. It should read as a friendly modest 'yes!' celebration, not a fighting stance.
- Each hand anatomically correct: four fingers naturally curled into the palm and one thumb folded across them, five digits total per hand, convincing knuckles/wrists, no extra or fused digits. No open palms, no waving, no crossed arms. Keep his thick sturdy forearms.

PRESERVE ALL INVARIANTS:
Exact normal image's 1024x1536 portrait canvas, waist-up framing and bottom crop, head scale and near-top location, body rotation toward same side, full round face shape, wide soft cheeks and rounded jaw, thick neck, broad shoulders and wide torso. Keep him EXACTLY the same stocky sturdy slightly chubby man; never slim the body/neck/cheeks or sharpen his jaw. Same curly brown hair, thick brows, brown eyes, tan skin, character identity, polished anime linework/shading.
Keep exact white technical jacket with cyan piping and navy panels/cuffs, light-blue collared shirt over navy turtleneck, dark-blue lanyard with cyan details, same badge. Small 'AI' collar emblem remains on VIEWER'S RIGHT; round 'AI' chest emblem with 'SUPPORT' below remains on viewer's right chest. ID badge must be visible and read exactly 'AI SUPPORT' and 'STAFF'. Preserve clothing design; adjust only sleeve folds needed for bent arms.

TRANSPARENCY: preserve genuine alpha transparency. Outside character silhouette must be alpha=0. Clean antialiased edges, no backdrop, no checkerboard, no shadow, no glow, no floating graphics, no stars, symbols or effect lines.
```

## Down: separate edit from final normal

```text
Use case: identity-preserve. Edit ONLY the attached FINAL NORMAL Makki image into the DOWN variation. Start directly from this normal image, not from the joy image. Produce ONE 1024x1536 portrait PNG.

EMOTION MUST BE MILD: a warm friendly 'ah, that's a shame' or 'aw, too bad', only a little disappointed. NOT sadness, depression, dejection, distress, crying, embarrassment or despair.
FACIAL CHANGE: a gentle small closed-mouth wry/rueful smile, slightly asymmetric, still warm and friendly toward viewer. Eyebrows ONLY slightly lowered toward the center, a very subtle expression, no deeply knitted brows. Brown eyes normal or barely lowered, still meeting the viewer. No downturned crying mouth, no droopy eyelids, no tears or sweat symbols. Preserve face fullness and soft cheeks.
BODY CHANGE: One hand rubbing the BACK OF HIS NECK in a casual warm 'ah well' gesture. Use the arm on the VIEWER'S LEFT: elbow bent out naturally, forearm reaching up along the left side of his body; palm/fingers rest naturally against the nape behind his ear with correct joint orientation. Anatomically plausible thick male hand with exactly five digits; some fingers may be naturally occluded behind the neck/hair, no extra fingers. Other arm remains lowered at his side with hand out of frame. Slight small head tilt that makes room for the neck-rubbing hand, keep head center almost unchanged. Shoulders only slightly relaxed, NOT slumped or hunched.

INVARIANTS: Keep the exact normal image's canvas size 1024x1536, waist-up crop and framing, overall character scale, large head and near-top head position, same body rotation toward the same side. Same EXACT stocky sturdy slightly chubby build, broad shoulders, thick neck, wide torso, round full face and soft substantial cheeks, wide gently rounded jaw. Do NOT slim him, hollow his cheeks, narrow his face, sharpen the jaw or shrink torso. Same curly brown hair, brown eyes, thick eyebrows, tan skin and warm identity, same polished anime style.
Keep exact white zip-up technical jacket with cyan piping and navy panels/cuffs, light-blue collared shirt over dark navy turtleneck, dark-blue/cyan lanyard, ID badge. Small 'AI' collar emblem stays on VIEWER'S RIGHT, round chest 'AI' and 'SUPPORT' remain in place. ID badge remains fully visible and reads exactly 'AI SUPPORT' and 'STAFF'. Only sleeve folds needed for arm change may change.

Preserve REAL ALPHA TRANSPARENCY: fully transparent background (alpha=0 outside silhouette), clean antialiased edges. No backdrop, checkerboard, shadow, halo, glow, effects, symbols or floating graphics.
```

