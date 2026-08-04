#define _GNU_SOURCE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int valid_nonce(const char *value) {
	if (value == NULL || strlen(value) != 64) return 0;
	for (size_t index = 0; index < 64; index += 1) {
		const char character = value[index];
		if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return 0;
	}
	return 1;
}

int main(int argc, char **argv) {
	if (argc != 2 || !valid_nonce(argv[1])) return 2;

	struct ucred credential;
	socklen_t credential_length = sizeof(credential);
	if (getsockopt(STDIN_FILENO, SOL_SOCKET, SO_PEERCRED, &credential, &credential_length) != 0) return 3;
	if (credential_length != sizeof(credential) || credential.pid <= 0) return 4;

	struct stat descriptor;
	if (fstat(STDIN_FILENO, &descriptor) != 0 || !S_ISSOCK(descriptor.st_mode)) return 5;

	if (printf(
		"{\"pid\":%ld,\"uid\":%ld,\"gid\":%ld,\"device\":\"%llu\",\"inode\":\"%llu\",\"nonce\":\"%s\"}\n",
		(long)credential.pid,
		(long)credential.uid,
		(long)credential.gid,
		(unsigned long long)descriptor.st_dev,
		(unsigned long long)descriptor.st_ino,
		argv[1]
	) < 0) return 6;
	return fflush(stdout) == 0 ? 0 : 7;
}
