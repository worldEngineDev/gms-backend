libMarvinSDK.so: MarvinSDK.cpp
	# Keep the SDK portable across the Agent's older Debian runtime.  The
	# container must not depend on the build host's GLIBCXX release.
	g++ *.cpp -Wall -O2 -fPIC -shared -static-libstdc++ -static-libgcc -o libMarvinSDK.so -lpthread -lrt -DCMPL_LIN
