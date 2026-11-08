# Black-hair character edits

Mode: built-in image_gen; separate image edit calls, transparent_background=true.
Final files: black-hair-joy.png and black-hair-down.png (1024 x 1536 RGBA PNG).
The normal image is the composition and identity source. The original transparent image is only the joy face reference.

## Joy edit prompt

Use case: identity-preserve.
Create ONE image edit: JOY variant of the character. This is an edit of input image 1, not a new composition.
Inputs: Image 1 (/expressions/black-hair-normal.png) is the base image and the authority for all composition, pose scale, character identity, costume and rendering. Image 2 (/transparent/black-hair.png) is ONLY a joyful facial-expression reference: his big wide toothy grin, happy eye shape and raised cheeks. Do NOT copy Image 2's head-on pose, shoulders-only crop, large face or framing.
Output: exactly 1024 x 1536 pixels, portrait PNG with real alpha transparency. Remove the entire background of image 1. All empty space must be fully transparent; retain crisp clean antialiased character edges. No backdrop, checkerboard, shadow behind the character, glow, effect lines, symbols or watermark.
Composition invariants: keep image 1's waist-up framing, exact bottom crop height around the waist, overall character scale, large head size, roughly the same head location (hair near top edge, face in upper third), and same three-quarter torso angle. Do not zoom out to fit the gesture. The character and jacket continue through the bottom edge just as in image 1. Keep his black tousled hair, brown eyes, facial identity, white and pale-blue jacket with cyan piping and dark side panels, dark undershirt, pale blue button shirt, blue lanyard, collar AI pin, round chest AI SUPPORT emblem and rectangular staff ID badge. Preserve the anime illustration style, precise linework and original light/shading.
Expression and pose edit: make his face like image 2's exuberant warm wide TOOTHY grin, raised cheeks and lively happy eyes; keep the facial angle of image 1, allowing a very slight lively head tilt. Change the arms and shoulders so one arm bends naturally into a single energetic FIST PUMP, with the clenched fist held at SHOULDER HEIGHT beside his upper chest/shoulder, fully inside the canvas. The other arm remains relaxed down as in image 1. Keep believable shoulder and elbow connections, natural sleeve folds and human anatomy. Each hand has exactly five fingers; on the clenched fist the four curled fingers and correctly opposed thumb are anatomically coherent, with no extra digits. Preserve the large original framing rather than shrinking the subject to accommodate the hand.
Text must remain clearly legible and spelled EXACTLY: badge top "AI SUPPORT"; badge lower "STAFF"; chest emblem "AI" with "SUPPORT" beneath. Preserve the original badge, lanyard and costume design.
Deliver only this ONE finished joy character cutout, never a sheet, collage or side-by-side comparison.

## Down edit prompt

Use case: identity-preserve.
Create ONE image edit: mildly disappointed / sheepish DOWN variant. EDIT THE PROVIDED NORMAL IMAGE directly; preserve its composition and identity.
Input image 1 (/expressions/black-hair-normal.png) is the base and authority for composition, scale, face identity, clothing, and illustration style.
Output: exactly 1024 x 1536 pixels portrait PNG with actual alpha transparency. Completely remove the original dark gradient backdrop and all its illumination outside the character. All background pixels are fully transparent; edges are clean and antialiased. No backdrop, checkerboard pattern, cast shadow outside the character, glow, effect lines, sweat symbols or watermark.
Keep invariant: the base image's waist-up framing, exact bottom crop around the waist, overall character scale, head size and roughly same head position, same three-quarter body angle. Hair should still approach the top edge, waist cropped by bottom edge. Do not shrink, zoom out or change to a bust crop. Keep the same black tousled hairstyle, brown eyes, warm friendly male identity, original anime illustration style and shading. Preserve the white and pale blue jacket with cyan piping and navy panels, pale blue button shirt, dark undershirt, blue lanyard, collar AI pin, chest AI SUPPORT emblem, rectangular ID badge and their locations.
Change expression AND pose: he is only A LITTLE disappointed, as if saying "aw, that's a shame" or "aw, too bad", while still friendly and approachable toward the viewer. A small SHEEPISH RUEFUL / WRY CLOSED-MOUTH SMILE, with only very slight asymmetry; brows only slightly lowered toward the center; eyes normal and open or barely lowered. Keep the expression light, warm and resilient. No sad face, depressed or dejected look, tears, downturned sad mouth, deeply knitted brows or worried arched inner brows.
One arm bends up naturally so ONE HAND SCRATCHES THE BACK OF HIS HEAD, with natural contact behind the upper rear of his hair, elbow gently pointing outward within the canvas. Five anatomically correct fingers with natural joints; the palm and fingers may be partly occluded by hair, but the anatomy must be coherent. The other arm remains relaxed down. Add only a small casual head tilt and slightly relaxed shoulders; do not slump, hunch or bow. Maintain original head scale, position and torso orientation while allowing the new shoulder gesture and appropriate sleeve folds.
Retain exact legible text: badge "AI SUPPORT" at top and "STAFF" below; chest emblem "AI" with "SUPPORT" beneath. Do not change spelling, lanyard, badge design or outfit.
Deliver just ONE finished mild down character cutout. No collage or multiple variants.

## Down facial refinement prompt

Use case: precise-object-edit / identity-preserve.
Make one very small facial correction to this finished 1024x1536 character image. KEEP EVERY OTHER DETAIL, all pixel framing, overall character and head size, head location, waist crop, three-quarter body angle, black hair, head tilt, pose with one hand scratching the back of his head, relaxed other arm, jacket, lanyard, badge, all readable lettering, illustration style and colors.
Change ONLY the eyebrows and the little forehead creases between them: the current inner eyebrow ends are raised too much and read as sadness or worry. Relax the brows to almost the normal natural shape, with inner ends only SLIGHTLY LOWERED toward the center, no inverted pleading arch, no deeply knitted brow, and REMOVE the worry creases. Keep his open friendly eyes and his tiny asymmetrical rueful CLOSED-MOUTH smile. The emotion is VERY MILD sheepish disappointment, "aw, too bad"; still warm, lighthearted and friendly. Not sad, worried, depressed, dejected, apologetic or distressed.
Keep text exact "AI SUPPORT" and "STAFF" on the ID badge and "AI" / "SUPPORT" on the chest. Keep five-finger hand anatomy, fingers partly hidden behind his hair.
Output exactly 1024x1536 PNG with fully transparent alpha background and clean antialiased edges. Preserve existing transparency and make any remaining backdrop pixels fully transparent: NO gray/dark gradient background, glow, shadow, effects or symbols. One image only.

