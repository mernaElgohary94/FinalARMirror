# Snap Lens TV Viewer

TV-first React app built with Snap Camera Kit Web. It loads one configured Lens from a Lens Group in a full-screen landscape view and provides an optional front/back camera switcher. Photo and video capture are intentionally disabled.

## Run it

1. Add the Camera Kit API token, Lens Group ID, and Lens ID from the Snap Developer Portal to `.env`.
2. Run `npm install` then `npm run dev`.
3. Open the supplied local URL on the TV's browser or a connected display. For a physical device, serve the app from an HTTPS host; browsers only allow camera access on HTTPS (except localhost).

## Notes

- The app requests camera video only; it does not request microphone access.
- The in-app **Tap to enable Lens sound** control handles browsers' autoplay restriction.
- Never commit the `.env` file with your live token.
