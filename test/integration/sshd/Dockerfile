# A stand-in Plesk server for the CI-only integration test: a real sshd, the
# real release manager, and a deploy account set up the way server-setup.sh
# sets it up (one sudo command, a root-only log).
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server sudo curl ca-certificates tar procps util-linux \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash acme-deploy \
 && install -d -m 700 -o acme-deploy -g acme-deploy /home/acme-deploy/.ssh /home/acme-deploy/incoming \
 && install -d /run/sshd /etc/acme

COPY app-deploy /usr/local/bin/acme-deploy
COPY deploy.conf /etc/acme/deploy.conf
COPY seed.sh /tmp/seed.sh

RUN chmod 755 /usr/local/bin/acme-deploy && chmod 644 /etc/acme/deploy.conf \
 && printf 'Defaults:acme-deploy !requiretty\nacme-deploy ALL=(root) NOPASSWD: /usr/local/bin/acme-deploy\n' > /etc/sudoers.d/acme-deploy \
 && chmod 440 /etc/sudoers.d/acme-deploy && visudo -cf /etc/sudoers.d/acme-deploy \
 && bash /tmp/seed.sh \
 && sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && ssh-keygen -A

EXPOSE 22
# The test passes its public key in AUTHORIZED_KEY; sshd's StrictModes needs the file owned by the user.
CMD ["/bin/sh", "-c", "printf 'restrict %s\\n' \"$AUTHORIZED_KEY\" > /home/acme-deploy/.ssh/authorized_keys && chown acme-deploy:acme-deploy /home/acme-deploy/.ssh/authorized_keys && chmod 600 /home/acme-deploy/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]
