// Starts the Google Cast receiver and hands the phone's messages to the clock (app.js, TV mode).
(function () {
  'use strict';
  const NAMESPACE = 'urn:x-cast:net.dgcinema.shabbosclock';
  // Opened in an ordinary browser (for a preview), there's no Cast framework: just show the clock.
  if (!window.cast || !cast.framework) return;
  const context = cast.framework.CastReceiverContext.getInstance();
  context.addCustomMessageListener(NAMESPACE, (event) => {
    try {
      window.tvData(typeof event.data === 'string' ? JSON.parse(event.data) : event.data);
    } catch (e) {}
  });
  const options = new cast.framework.CastReceiverOptions();
  // A clock, not media: keep running with nothing playing and after the phone disconnects.
  options.disableIdleTimeout = true;
  options.skipPlayersLoad = true;
  options.statusText = 'Shabbos Clock';
  options.customNamespaces = { [NAMESPACE]: cast.framework.system.MessageType.JSON };
  context.start(options);
})();
