module.exports = {
  apps: [{
    name: "midistage-telnet",
    script: "midistage.js",
    args: "--telnet --port 2339",
    cwd: "/home/kexxie/dev/nodejs/midistage",
    env: {
      NODE_ENV: "production"
    },
    restart_delay: 2000
  }]
};
