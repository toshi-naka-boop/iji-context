# Makki expression prompts

Mode: built-in image_gen, one generation/edit at a time.
Canvas: 1024 x 1536 PNG with real alpha transparency.

## Normal generation
Use case: identity-preserve anime character portrait. Produce ONE final PNG image, portrait canvas EXACTLY 1024 x 1536, with genuine alpha transparency.
INPUT 1 (/transparent/suit.png): COMPOSITION REFERENCE ONLY, also called Haru reference. Match this reference's waist-up crop, subject scale, head size and position near the top, shoulder and torso placement, slight three-quarter body turn toward the same side (screen right), head angle and direct viewer gaze. Do not copy the woman, her face, hair, earrings, crossed arms, or background.
INPUT 2 (/transparent/makki.png): CHARACTER IDENTITY AND UNIFORM reference. The subject to draw is ONLY this young adult man, Makki. Keep his recognizably same face shape, warm brown eyes, thick dark eyebrows, short tousled voluminous wavy dark brown hair with warm brown highlights, warm skin tone, and masculine youthful facial proportions. No earrings. Preserve the polished anime illustration style and quality of the references.
Redraw Makki in the EXACT COMPOSITION of INPUT 1, keeping his male identity. His head and gaze face the viewer with the same slight head angle as INPUT 1. Canvas top very close to the top of his hair, with all hair tips inside the canvas. Large waist-up portrait, cropped at the same torso height as INPUT 1; shoulder line and neck at the same height as INPUT 1; do not make a distant or full body view.
POSE: both arms naturally relaxed and lowered along his sides. Hands below the lower canvas edge, mostly out of frame. Natural relaxed shoulders. NO raised hands, NO wave, NO crossed arms. Use the reference's slight body turn but change both arms to this relaxed-down pose.
UNIFORM: preserve the white zip-up technical jacket with cyan piping and navy side panels; light-blue collared shirt over a dark navy turtleneck; dark-blue lanyard; hanging rectangular ID badge. Chest has the round cyan-on-navy "AI" emblem with "SUPPORT" underneath. Badge top blue band must read EXACTLY "AI SUPPORT" in white and below read EXACTLY "STAFF" in navy. Readable correct English spelling. Preserve collar AI pin.
EXPRESSION NORMAL: calm, friendly neutral face, relaxed brows and eyes, a gentle small CLOSED-MOUTH smile, no teeth visible; modest natural cheek warmth.
BACKGROUND: truly empty fully transparent alpha=0 outside the character, clean antialiased edges, no colored halo, no backdrop, no black/white background, no checkerboard, no floor, no shadow, no floating graphics.
This is the master normal-expression sprite for an aligned expression set. Anatomically clean, refined anime line art, soft polished cel shading. Single character, single image.

## Normal composition correction (selected master)
Edit the FIRST image (Makki, the young man) to correct ONLY his portrait orientation/composition to match the SECOND image (Haru composition reference). Final exact 1024x1536 PNG, genuine alpha transparency.
CRITICAL CORRECTION: His current head tilt and shoulders are the opposite of Haru. Repose him so his eye line slopes slightly DOWN toward screen RIGHT, like Haru. His face center/chin is slightly LEFT of the canvas center, like Haru. His screen-LEFT ear is the more visible ear, like Haru. His shoulders/body turn the SAME way as Haru, slightly toward screen RIGHT. His screen-LEFT shoulder is a little higher than his screen-RIGHT shoulder. Match Haru's head placement and head scale and waist-up crop. The head top stays very close to the top edge, all hair tips inside.
Keep Makki's EXACT male identity from the first image: youthful warm face shape, brown eyes, thick eyebrows, tousled short wavy dark brown hair, warm skin tone. Do NOT copy Haru's female face, hair, earrings, body proportions, or arms. Makki has no earrings.
Keep BOTH ARMS RELAXED AND LOWERED at his sides, hands below the canvas bottom. NO waving, NO crossed arms.
Keep his calm friendly gentle CLOSED-MOUTH smile and relaxed eyes.
Preserve the exact uniform design from the first image, including navy turtleneck, light blue shirt, white technical jacket, cyan piping, navy panels, dark blue lanyard, collar AI pin, chest circular AI/SUPPORT emblem on the screen-right side, and ID badge with EXACT readable "AI SUPPORT" and "STAFF". Keep all text properly readable; do not mirror text.
Use the same polished anime line art and shading. Outside the character use only alpha=0, clean antialiased silhouette, no backdrop, no shadows, no added graphics. One character only.

## Joy edit from normal
Use case: precise local expression edit / identity-preserve.
Edit the attached NORMAL master image into JOY. ONE PNG, exactly 1024x1536, keep its real alpha transparency.
This is an aligned game character expression sprite: do NOT redraw or regenerate the portrait. Retain the exact original pixels and alpha everywhere except the eyebrows, eyelids/eyes, mouth, and subtle cheek expression marks inside the face. Only the facial-expression features may change. The expression edit is entirely within x=330..680 and y=290..575; outside this local face area the image MUST remain pixel-identical to the input.
JOY expression: clearly happy and warm, a bright natural smile with lips opening a little to show upper teeth, eyes softly narrowed with delight while still recognizably brown, eyebrows raised a little. His happy smile is friendly and natural, not exaggerated.
LOCK UNCHANGED: hair in every strand and position, head size/position/tilt, face outline, ears, nose, skin color, neck, pose, lowered arms, body, shoulders, exact framing, uniform folds and colors, cyan piping and navy panels, collar AI pin, chest AI/SUPPORT logo, lanyard, ID badge, every text pixel reading "AI SUPPORT" / "STAFF", entire silhouette and background alpha. No change to lighting or overall color.
No tears, no symbols, no graphics, no background, no shadows, no hand gestures. Return the original image with ONLY the requested localized facial-feature changes.

## Down edit from normal
Use case: precise local expression edit / identity-preserve.
Edit the attached NORMAL master image into DOWN. ONE PNG, exactly 1024x1536, preserve genuine alpha transparency.
This is an aligned character expression sprite: preserve the base portrait. Change ONLY the eyebrows, eyes/eyelids, mouth, and subtle cheeks inside the face. Preserve the exact original pixels and alpha everywhere else. The expression edit is entirely within x=330..680 and y=290..575; outside that local facial area the image MUST be pixel-identical to the normal input.
DOWN expression: dejected and sympathetic, gently worried sloping eyebrows conveying sadness, eyes slightly downcast while still recognizably warm brown, a small restrained frown with lips pressed closed. Brows softly slant toward the center in a vulnerable sympathetic way; keep him gentle, NOT angry or scowling. No smile, no teeth, no tears, no sweat or symbols.
LOCK UNCHANGED: his exact youthful male identity, face outline, ears, nose, skin tone, every hair strand, head size/position/tilt, neck, pose, lowered arms, body, shoulders, crop, all uniform folds and colors, cyan piping and navy panels, collar AI pin, chest AI/SUPPORT emblem, lanyard, ID badge, all readable text "AI SUPPORT" / "STAFF", entire silhouette and original alpha channel. No change in lighting, color, scale, position, or anatomy.
Outside the character keep the background completely transparent alpha=0. Do not add any backdrop, shadow, graphics, or gestures. Return the original image with ONLY the requested localized facial-feature edits.

## Preservation
The generated expression features were applied locally to the normal master. All pixels outside the facial edit area and the complete alpha channel are identical across the final files. The original master pixels are retained for the body, arms, uniform, badge text, silhouette, and transparent background.

