/*
 * 麦尼海塘 · 视频按需播放
 * - 带 data-autoplay 的视频：进入视口才开始加载，并静音循环播放；离开视口即暂停。
 * - 访客开启“减少动态效果”或省流量模式时，不自动播放，只显示封面并保留播放按钮。
 * - 访客手动打开声音后，再次回到视口时不会被强制静音。
 */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var saveData = navigator.connection && navigator.connection.saveData;
  var lazyVideos = Array.prototype.slice.call(document.querySelectorAll("video[data-autoplay]"));
  var heroVideos = Array.prototype.slice.call(document.querySelectorAll("video[autoplay]"));

  function safePlay(video) {
    try {
      var result = video.play();
      if (result && typeof result.catch === "function") result.catch(function () {});
    } catch (error) {
      /* 浏览器拒绝自动播放时保持封面即可 */
    }
  }

  // 减少动态效果 / 省流量：首屏视频也停下，所有视频改为手动播放
  if (reduceMotion || saveData) {
    heroVideos.concat(lazyVideos).forEach(function (video) {
      video.removeAttribute("autoplay");
      video.pause();
      if (!video.hasAttribute("controls")) video.setAttribute("controls", "");
    });
    return;
  }

  if (!lazyVideos.length) return;

  // 旧浏览器不支持 IntersectionObserver：退回为手动播放
  if (!("IntersectionObserver" in window)) {
    lazyVideos.forEach(function (video) {
      if (!video.hasAttribute("controls")) video.setAttribute("controls", "");
    });
    return;
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        var video = entry.target;
        if (entry.isIntersecting) {
          if (video.dataset.userSound !== "1") video.muted = true;
          if (video.preload === "none") video.preload = "auto";
          safePlay(video);
        } else if (!video.paused) {
          video.pause();
        }
      });
    },
    { rootMargin: "120px 0px", threshold: 0.2 }
  );

  lazyVideos.forEach(function (video) {
    video.addEventListener("volumechange", function () {
      if (!video.muted) video.dataset.userSound = "1";
    });
    observer.observe(video);
  });
})();
