# Black-hair expression prompts

Method: built-in image_gen.imagegen, one sequential call per image; transparent_background=true.

Normal references: transparent/suit.png (composition) and transparent/black-hair.png (identity).
Joy and down edit target: expressions/black-hair-normal.png.

## Normal

Use case: identity-preserve.
Create one polished anime character portrait PNG, EXACTLY 1024 pixels wide by 1536 pixels high, with REAL ALPHA TRANSPARENCY.

INPUT ROLES:
- First attached reference (/transparent/suit.png): COMPOSITION ONLY. Match its waist-up crop, camera distance, head size, head placement almost touching the top, slight three-quarter torso turn toward viewer's RIGHT, same gentle clockwise head angle and eyes directed toward the viewer. Do not copy her identity, female anatomy, long hair, earrings, or crossed arms. Do not copy its backdrop.
- Second attached reference (/transparent/black-hair.png): CHARACTER IDENTITY AND UNIFORM. Draw this exact adult young man: the same masculine face shape, warm skin tone, brown irises, thick dark eyebrows, short tousled spiky BLACK hair with the same distinctive silhouette, no earrings, and the same polished anime drawing and shading style.

COMPOSITION IS CRITICAL:
Portrait 1024x1536 canvas, large waist-up framing exactly like the first reference. Top of spiky hair at approximately y=5 to 15 px, face at the same large scale and position as the first reference; chin approximately y=665, shoulder line approximately y=800, torso continues and is cropped at y=1536 at the same waist height. Do not shrink the head or leave large empty space above it. Torso slight three-quarter turn toward viewer's RIGHT, head looks toward viewer with the reference's gentle head angle. The man's shoulders remain naturally masculine. BOTH ARMS RELAXED AND LOWERED NATURALLY AT THE SIDES, extending down out of the frame. Hands mostly out of frame. No waving, no raised hands, no crossed arms. The arms must not cross the torso.

NORMAL EXPRESSION:
Calm friendly neutral face, soft open brown eyes, relaxed eyebrows, gentle CLOSED-MOUTH smile. Keep his exact identity; no teeth visible.

UNIFORM:
Preserve the second reference uniform: white zip-up technical jacket, bright cyan piping, navy side panels, light-blue collared button shirt over a dark navy turtleneck, dark-blue/cyan detailed lanyard, rectangular hanging staff ID badge, round cyan-and-navy AI chest emblem with SUPPORT beneath, small AI collar emblem. ID badge lettering EXACTLY "AI SUPPORT" (upper blue bar) and "STAFF" (lower field), spelled A I [space] S U P P O R T and S T A F F. Chest emblem reads "AI" with "SUPPORT" below. Preserve crisp illustration detail and accurate garment construction.

BACKGROUND:
Every pixel outside the character MUST be fully transparent alpha=0. Clean antialiased silhouette. No white/colored/black backdrop, no gradient, no checkerboard drawn into image, no shadow behind or under him, no floating graphics, no extra objects or text. Only the character on a genuinely transparent canvas.

Generate only this normal-expression image. This becomes the master for later face-only expression edits.

## Joy

Use case: precise-object-edit / identity-preserve.
EDIT TARGET: the attached /expressions/black-hair-normal.png, the approved master portrait. Produce a FACE-ONLY EXPRESSION EDIT of this exact PNG. Output exactly 1024x1536, RGBA PNG with genuine alpha transparency.

CHANGE ONLY eyebrows, eyes, mouth, and cheeks INSIDE the face to JOY:
A clearly happy, bright friendly smile with the mouth open slightly, upper teeth subtly visible; brown eyes softly narrowed with delight, eyebrows raised just a little, cheeks slightly lifted. He is smiling toward the viewer. Preserve the character's specific facial identity, eye color, nose, jaw outline, skin tone, head angle and gaze.

STRICT INVARIANTS:
All pixels outside those facial features should remain identical to the master. Do not redraw, shift, resize, recolor or reinterpret the whole illustration. Copy the master image everywhere except the local expression features. Hair including every spike and highlight, ears, nose, neck, clothing, jacket folds, cyan piping, emblems, lanyard, staff badge, relaxed lowered arms, shoulders, proportions, lighting, linework, pose, three-quarter torso angle, framing, canvas, silhouette and transparency must stay completely unchanged. Exact same head position, scale, waist crop and arm position. No extra objects. No raised hands. No crossed arms.

Text remains EXACTLY as in the master: ID badge "AI SUPPORT" / "STAFF"; round chest emblem "AI" and "SUPPORT"; collar "AI". Preserve all lettering without regenerating it.

BACKGROUND: Preserve the master's alpha channel unchanged: fully transparent outside the character, clean antialiased silhouette; do not add any backdrop, gradient, shadow or graphics. Only the local facial expression changes. Generate one joy image only.

## Down

Use case: precise-object-edit / identity-preserve.
EDIT TARGET: attached /expressions/black-hair-normal.png. It is the master NORMAL image; edit it directly to make DOWN, not joy. Produce exactly one 1024x1536 RGBA PNG with real alpha transparency.

CHANGE ONLY eyebrows, eyes, mouth, cheeks INSIDE the face:
DOWN expression: dejected and sympathetic, gently sad. Inner ends of the eyebrows lift slightly to form worried, softly slanting brows toward the center; eyes slightly downcast with a sad softened gaze, recognizable brown irises; a SMALL CLOSED-MOUTH FROWN with pressed lips. No tears, no anger, no fierce lowered brows, no crying, no open mouth. Keep his facial identity, nose, masculine jaw outline, skin tone, and the exact head angle.

EVERYTHING ELSE IS LOCKED:
Keep all pixels outside the expression features identical to the original normal master. Preserve hair and each spike, ears, nose, chin and facial outline, neck, collar, uniform, garment folds, all cyan piping, navy panels, lanyard, badge and emblems, lowered relaxed arms, body proportions, shoulders, pose, head placement, canvas framing and size, original illustration lighting and linework. No redrawing the body. Exact same slight three-quarter turn toward viewer's RIGHT and same head tilt. Arms naturally down at the sides; hands outside frame, no waving or crossed arms. Preserve waist-up crop and all positions unchanged.

Do not regenerate lettering. Badge must still read "AI SUPPORT" / "STAFF"; chest "AI" / "SUPPORT"; collar "AI", exactly as the master.

Preserve real transparency: alpha=0 outside character, antialiased silhouette, no backdrop of any color, no shadow, no floating graphics. Copy the master everywhere except these localized face features.

